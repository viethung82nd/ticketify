import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  DayType,
  type Page,
  Role,
  SeatType,
} from '@ticketify/shared';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { expireBookingJobId } from '../../src/infra/queue/booking-queue';
import { BookingQueueProducer } from '../../src/infra/queue/booking-queue.producer';
import { QueueWorkers } from '../../src/infra/queue/queue-workers';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import {
  BookingExpiryService,
  isLockTimeout,
  SWEEP_BATCH_SIZE,
  type SweepReport,
  WORKER_LOCK_TIMEOUT_MS,
} from '../../src/modules/bookings/booking-expiry.service';
import { bookingCode } from '../../src/modules/bookings/booking-rules';
import type { ExpireOutcome, ExpireOutcomeKind } from '../../src/modules/bookings/expire-booking';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
/** holdUntil of a booking created at the clock's "now". */
const HOLD_MINUTES = (HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS) / 60;
/** At most 8 expiries run at once here; several suites share one Postgres (max 100). */
const POOL_MAX = 10;
const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string | number): Date => new FakeClock(value).now();

/** Deterministic PRNG (mulberry32) so a failing concurrency round can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` (real time) until it returns true; fails after `timeoutMs`. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

interface TestUser {
  id: string;
  token: string;
}

const emptyOutcomes = (): Record<ExpireOutcomeKind, number> => ({
  expired: 0,
  skipped: 0,
  noop: 0,
  early: 0,
});

describe('Booking expiry — job, sweep, lazy release, reads, rate limit (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  /** Worker side, compiled but not started: its services are called directly. */
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let adminToken: string;
  const clock = new FakeClock(NOW);

  /** A worker context like `main.worker.ts` boots (no sweep scheduler: tests call sweep()). */
  async function workerModule(): Promise<TestingModule> {
    const { WorkerModule } = await import('../../src/worker.module.js');
    return Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .compile();
  }

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
          PAYMENT_GRACE_SECONDS: String(PAYMENT_GRACE_SECONDS),
          DATABASE_POOL_MAX: String(POOL_MAX),
        },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0, '127.0.0.1');
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
    // Showtimes lock their seat prices at creation: the price table must exist.
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: 90_000 })),
      ),
    });

    workerRef = await workerModule();
    expiry = workerRef.get(BookingExpiryService);
  });

  afterAll(async () => {
    await workerRef?.close();
    await app?.close();
    // Delayed expire-booking jobs of this suite live in its Redis database: flushed here.
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => clock.set(NOW));

  afterEach(() => jest.restoreAllMocks());

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const tokenOf = (id: string) => app.get(AccessTokenIssuer).issue({ id, role: Role.USER }).token;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `expiry-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Expiry User ${userCounter}`,
      },
    });
    return { id: user.id, token: tokenOf(user.id) };
  }

  const hold = (user: TestUser, showtimeId: string, seatIds: string[], key = randomUUID()) =>
    http()
      .post('/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ showtimeId, seatIds });

  async function held(user: TestUser, showtimeId: string, seatIds: string[]): Promise<Booking> {
    const res = await hold(user, showtimeId, seatIds);
    expect(res.status).toBe(201);
    return bodyOf<Booking>(res);
  }

  const get = (user: TestUser, path: string) =>
    http().get(path).set('Authorization', `Bearer ${user.token}`);

  const admin = (path: string, body: object) =>
    http().post(path).set('Authorization', `Bearer ${adminToken}`).send(body);

  let roomCounter = 0;
  /** `rows × cols` STANDARD seats; `seat('A1')` gives the id, `seats` all ids in label order. */
  async function room(rows = 2, cols = 5) {
    roomCounter += 1;
    const res = await admin('/admin/rooms', { name: `Phòng Expiry ${roomCounter}`, rows, cols });
    expect(res.status).toBe(201);
    const created = bodyOf<AdminRoom>(res);
    const ids = new Map(created.seats.map((s) => [`${s.row}${s.number}`, s.id]));
    const seat = (label: string) => {
      const id = ids.get(label);
      if (!id) throw new Error(`No seat ${label}`);
      return id;
    };
    return { room: created, seat, seats: [...ids.values()] };
  }

  let movieId: string | undefined;
  let showtimeCounter = 0;
  /** A new upcoming showtime (Monday 2026-11-02, a fresh room each time unless given). */
  async function showtime(roomId?: string) {
    movieId ??= (
      await db.prisma.movie.create({
        data: {
          title: 'Expiry Movie',
          slug: `expiry-movie-${randomUUID()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: instant('2026-10-01'),
        },
      })
    ).id;
    showtimeCounter += 1;
    const hour = 8 + 2 * (showtimeCounter % 7);
    const res = await admin('/admin/showtimes', {
      movieId,
      roomId: roomId ?? (await room()).room.id,
      startsAt: vn('2026-11-02', `${String(hour).padStart(2, '0')}:00`),
    });
    expect(res.status).toBe(201);
    return bodyOf<CreatedShowtime>(res);
  }

  /** Fresh 2×5 room + one showtime in it. */
  async function scene(rows = 2, cols = 5) {
    const r = await room(rows, cols);
    const st = await showtime(r.room.id);
    return { ...r, showtime: st };
  }

  /**
   * A PENDING booking written straight into the database (seats HELD by it until `holdUntil`),
   * for tests that need many bookings. Same rows the hold flow writes.
   */
  async function pendingBooking(
    userId: string,
    showtimeId: string,
    seatIds: string[],
    holdUntil: Date,
  ): Promise<string> {
    const booking = await db.prisma.booking.create({
      data: {
        code: bookingCode(),
        userId,
        showtimeId,
        status: 'PENDING',
        subtotal: 0,
        total: 0,
        expiresAt: instant(holdUntil.getTime() - PAYMENT_GRACE_SECONDS * 1_000),
        holdUntil,
        idempotencyKey: randomUUID(),
        requestHash: 'test',
        createdAt: clock.now(),
      },
      select: { id: true },
    });
    await db.prisma.bookingSeat.createMany({
      data: seatIds.map((seatId) => ({ bookingId: booking.id, showtimeId, seatId, price: 0 })),
    });
    const updated = await db.prisma.showtimeSeat.updateMany({
      where: { showtimeId, seatId: { in: seatIds }, status: 'AVAILABLE' },
      data: { status: 'HELD', bookingId: booking.id, heldUntil: holdUntil },
    });
    expect(updated.count).toBe(seatIds.length);
    return booking.id;
  }

  const bookingStatus = async (id: string) =>
    (await db.prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  const seatRow = (showtimeId: string, seatId: string) =>
    db.prisma.showtimeSeat.findUniqueOrThrow({
      where: { showtimeId_seatId: { showtimeId, seatId } },
      select: { status: true, bookingId: true, heldUntil: true },
    });

  /** Invariant: an EXPIRED booking never still holds a seat. */
  async function expiredStillHolding(): Promise<number> {
    const [row] = await db.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM showtime_seats s
      JOIN bookings b ON b.id = s.booking_id
      WHERE b.status = 'EXPIRED' AND s.status = 'HELD'`;
    return row?.n ?? -1;
  }

  /** Bookings PENDING past holdUntil (on the fake clock). */
  async function overduePending(): Promise<number> {
    const [row] = await db.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bookings
      WHERE status = 'PENDING' AND hold_until <= ${clock.now()}`;
    return row?.n ?? -1;
  }

  const sqlStateOf = (error: unknown): string | undefined => {
    const text = error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error);
    return /40P01|deadlock/i.test(text) ? '40P01' : undefined;
  };

  /**
   * Splits expirations by booking and by who did them. The sweep expires each booking through
   * `expiry.expire`, so a spy on it sees every booking the sweep touched; the "job" side calls
   * the returned `job` (the original method), which the spy does not see.
   */
  function attributeExpirations() {
    const job = expiry.expire.bind(expiry);
    const bySweep: { id: string; outcome: ExpireOutcomeKind }[] = [];
    jest.spyOn(expiry, 'expire').mockImplementation(async (id) => {
      const result = await job(id);
      bySweep.push({ id, outcome: result.outcome });
      return result;
    });
    return {
      job,
      /** Outcomes of `id` in the sweep since the last `reset()`. */
      sweepOutcomes: (id: string) =>
        bySweep.filter((call) => call.id === id).map((call) => call.outcome),
      /** Expirations of `id` by the sweep since the last `reset()`. */
      sweepExpired: (id: string) =>
        bySweep.filter((call) => call.id === id && call.outcome === 'expired').length,
      reset: () => bySweep.splice(0),
    };
  }

  /** Locks one seat row from another connection so expireBooking blocks at step 6. */
  async function lockSeat(showtimeId: string, seatId: string): Promise<Client> {
    const blocker = new Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT 1 FROM showtime_seats WHERE showtime_id = $1 AND seat_id = $2 FOR UPDATE',
      [showtimeId, seatId],
    );
    return blocker;
  }

  // ─── expire-booking job ───

  describe('expireBooking (job)', () => {
    it('runs twice: expired, then noop; seats back to AVAILABLE with booking_id NULL', async () => {
      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1'), seat('A2')]);
      clock.advance({ minutes: HOLD_MINUTES });

      await expect(expiry.expire(booking.id)).resolves.toEqual({
        outcome: 'expired',
        releasedSeats: 2,
      });
      await expect(expiry.expire(booking.id)).resolves.toEqual({ outcome: 'noop' });

      expect(await bookingStatus(booking.id)).toBe('EXPIRED');
      for (const label of ['A1', 'A2']) {
        expect(await seatRow(st.id, seat(label))).toEqual({
          status: 'AVAILABLE',
          bookingId: null,
          heldUntil: null,
        });
      }
    });

    it('early before holdUntil: nothing changes', async () => {
      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1')]);
      clock.advance({ minutes: HOLD_MINUTES - 1 });

      await expect(expiry.expire(booking.id)).resolves.toEqual({
        outcome: 'early',
        holdUntil: instant(booking.holdUntil),
      });
      expect(await bookingStatus(booking.id)).toBe('PENDING');
      expect((await seatRow(st.id, seat('A1'))).status).toBe('HELD');
    });

    it('noop for an unknown booking; skipped while another transaction holds the booking row', async () => {
      await expect(expiry.expire(UNKNOWN_ID)).resolves.toEqual({ outcome: 'noop' });

      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1')]);
      clock.advance({ minutes: HOLD_MINUTES });
      const other = new Client({ connectionString: db.url });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query('SELECT 1 FROM bookings WHERE id = $1 FOR UPDATE', [booking.id]);

        // SKIP LOCKED: no wait on the other transaction (it never commits here), no error.
        const who = attributeExpirations();
        // Wall-clock time spent waiting (performance.now(): not business time, no ClockService).
        const started = performance.now();
        await expect(who.job(booking.id)).resolves.toEqual({ outcome: 'skipped' });
        const report = await expiry.sweep();
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(report.failed).toBe(0);
        // (Bookings left overdue by earlier tests may be expired by this sweep: only ours counts.)
        expect(who.sweepOutcomes(booking.id)).toEqual(['skipped']);
        expect(await bookingStatus(booking.id)).toBe('PENDING');
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
      await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
    });

    it('lazy expiry: B took A’s expired seat before A’s job ran; A’s job leaves it with B', async () => {
      const { seat, showtime: st } = await scene();
      const a = await held(await newUser(), st.id, [seat('A1'), seat('A2')]);
      clock.advance({ minutes: HOLD_MINUTES });

      // No job has run: A is still PENDING, its seats still HELD but past held_until.
      expect(await bookingStatus(a.id)).toBe('PENDING');
      const b = await held(await newUser(), st.id, [seat('A1')]);

      await expect(expiry.expire(a.id)).resolves.toEqual({ outcome: 'expired', releasedSeats: 1 });

      expect(await bookingStatus(a.id)).toBe('EXPIRED');
      expect(await seatRow(st.id, seat('A1'))).toEqual({
        status: 'HELD',
        bookingId: b.id,
        heldUntil: instant(b.holdUntil),
      });
      // A's other seat, which nobody took, is released.
      expect(await seatRow(st.id, seat('A2'))).toMatchObject({
        status: 'AVAILABLE',
        bookingId: null,
      });
      expect(await bookingStatus(b.id)).toBe('PENDING');
    });

    it('a SOLD seat of an overdue PENDING booking is never released', async () => {
      const { seat, showtime: st } = await scene();
      const a = await held(await newUser(), st.id, [seat('A1'), seat('A2')]);
      // As payment will (phase 3): the seat is SOLD to booking A.
      await db.prisma.showtimeSeat.update({
        where: { showtimeId_seatId: { showtimeId: st.id, seatId: seat('A1') } },
        data: { status: 'SOLD', heldUntil: null },
      });
      clock.advance({ minutes: HOLD_MINUTES });

      await expect(expiry.expire(a.id)).resolves.toEqual({ outcome: 'expired', releasedSeats: 1 });

      expect(await seatRow(st.id, seat('A1'))).toEqual({
        status: 'SOLD',
        bookingId: a.id,
        heldUntil: null,
      });
      expect((await seatRow(st.id, seat('A2'))).status).toBe('AVAILABLE');
    });
  });

  // ─── Sweep (cron) ───

  describe('sweep', () => {
    it(`150 overdue bookings: rounds of ${SWEEP_BATCH_SIZE} within one job until none is left`, async () => {
      await expiry.sweep(); // whatever earlier tests left overdue
      const { seats, showtime: st } = await scene(10, 15);
      const user = await newUser();
      const holdUntil = clock.now();
      const ids: string[] = [];
      for (const seatId of seats)
        ids.push(await pendingBooking(user.id, st.id, [seatId], holdUntil));
      // Not overdue yet: untouched.
      const notYet = await pendingBooking(
        user.id,
        (await showtime()).id,
        [],
        instant(clock.now().getTime() + 60_000),
      );
      clock.advance({ seconds: 1 });

      const report = await expiry.sweep();

      expect(report).toEqual<SweepReport>({
        batches: [100, 50],
        outcomes: { ...emptyOutcomes(), expired: 150 },
        busy: 0,
        failed: 0,
      });
      expect(await overduePending()).toBe(0);
      expect(await db.prisma.booking.count({ where: { id: { in: ids }, status: 'EXPIRED' } })).toBe(
        150,
      );
      expect(
        await db.prisma.showtimeSeat.count({ where: { showtimeId: st.id, status: 'AVAILABLE' } }),
      ).toBe(150);
      expect(await bookingStatus(notYet)).toBe('PENDING');
    });

    it('a booking that fails does not stop the others and is not retried in the same job', async () => {
      await expiry.sweep();
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const ids = await Promise.all(
        ['A1', 'A2', 'A3'].map((label) =>
          pendingBooking(user.id, st.id, [seat(label)], clock.now()),
        ),
      );
      clock.advance({ seconds: 1 });
      const failing = ids[1]!;
      const real = expiry.expire.bind(expiry);
      jest
        .spyOn(expiry, 'expire')
        .mockImplementation((id) =>
          id === failing ? Promise.reject(new Error('boom')) : real(id),
        );
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const report = await expiry.sweep();

      expect(report).toEqual({
        batches: [3],
        outcomes: { ...emptyOutcomes(), expired: 2 },
        busy: 0,
        failed: 1,
      });
      expect(errors).toHaveBeenCalledTimes(1);
      expect(await bookingStatus(failing)).toBe('PENDING');
      jest.restoreAllMocks();
      await expect(expiry.sweep()).resolves.toMatchObject({ outcomes: { expired: 1 } });
    });

    it(`seats locked over ${WORKER_LOCK_TIMEOUT_MS} ms: the expiry gives up (55P03, rolled back); the sweep counts it busy`, async () => {
      await expiry.sweep();
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const id = await pendingBooking(user.id, st.id, [seat('A1')], clock.now());
      clock.advance({ seconds: 1 });
      const blocker = await lockSeat(st.id, seat('A1'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        // Wall-clock time spent waiting (performance.now(): not business time, no ClockService).
        const started = performance.now();
        const error = await expiry.expire(id).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        const waited = performance.now() - started;
        expect(isLockTimeout(error)).toBe(true);
        expect(waited).toBeGreaterThanOrEqual(WORKER_LOCK_TIMEOUT_MS - 100);
        expect(waited).toBeLessThan(WORKER_LOCK_TIMEOUT_MS + 2_000);
        // Rolled back: the booking UPDATE before the seat lock is gone too.
        expect(await bookingStatus(id)).toBe('PENDING');
        expect((await seatRow(st.id, seat('A1'))).status).toBe('HELD');

        const report = await expiry.sweep();
        expect(report).toMatchObject({ busy: 1, failed: 0, outcomes: { expired: 0 } });
        expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toContain(id);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
      }
      await expect(expiry.expire(id)).resolves.toMatchObject({ outcome: 'expired' });
    });

    it('sweep and job on the same booking: exactly one expires it, the other gets skipped or noop', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const tally = { job: emptyOutcomes(), sweep: emptyOutcomes() };
      const who = attributeExpirations();
      const rows: string[] = [];
      let total = 0;
      for (let i = 0; i < 10; i++) {
        await expiry.sweep();
        const id = await pendingBooking(user.id, st.id, [seat('A1')], clock.now());
        who.reset();
        // Alternate which one starts first.
        const [job, sweep] = await Promise.all([
          pause(i % 2 === 0 ? 0 : 25).then(() => who.job(id)),
          pause(i % 2 === 0 ? 1 : 0).then(() => expiry.sweep()),
        ]);
        tally.job[job.outcome] += 1;
        for (const [kind, n] of Object.entries(sweep.outcomes)) {
          tally.sweep[kind as ExpireOutcomeKind] += n;
        }
        // This booking, this round: expired exactly once, by the job or by the sweep.
        const byJob = Number(job.outcome === 'expired');
        const bySweep = who.sweepExpired(id);
        rows.push(`round ${i + 1}: job ${job.outcome}, sweep expired ${bySweep}`);
        expect(byJob + bySweep).toBe(1);
        expect(['expired', 'skipped', 'noop']).toContain(job.outcome);
        expect(sweep.failed).toBe(0);
        expect(await bookingStatus(id)).toBe('EXPIRED');
        expect((await seatRow(st.id, seat('A1'))).status).toBe('AVAILABLE');
        total += byJob + bySweep;
      }
      expect(total).toBe(10);
      console.info(
        `[2.10] job vs sweep on one booking, 10 rounds: ${JSON.stringify(tally)}\n  ` +
          rows.join('\n  '),
      );
    });

    it('job and sweep in parallel, 20 rounds (seed 8): each booking expired exactly once, no error, no deadlock', async () => {
      const { seats, showtime: st } = await scene();
      const user = await newUser();
      const rnd = random(8);
      const tally = { job: emptyOutcomes(), sweep: emptyOutcomes() };
      let errors = 0;
      let deadlocks = 0;
      const rows: string[] = [];
      const who = attributeExpirations();

      for (let round = 0; round < 20; round++) {
        await expiry.sweep();
        // 6 bookings of 1 seat each; the seats were released by the previous round.
        const ids: string[] = [];
        for (const seatId of seats.slice(0, 6)) {
          ids.push(await pendingBooking(user.id, st.id, [seatId], clock.now()));
        }
        who.reset();
        // Jobs start 0–11 ms late, sweeps 0–3 ms: either side may reach a booking first.
        const delayed = <T>(maxMs: number, work: () => Promise<T>) =>
          pause(Math.floor(rnd() * maxMs)).then(work);
        const settled = await Promise.allSettled<ExpireOutcome | SweepReport>([
          ...ids.map((id) => delayed(12, () => who.job(id))),
          delayed(4, () => expiry.sweep()),
          delayed(4, () => expiry.sweep()),
        ]);

        const byJob = new Map<string, number>();
        for (const [i, result] of settled.entries()) {
          if (result.status === 'rejected') {
            errors += 1;
            if (sqlStateOf(result.reason)) deadlocks += 1;
            continue;
          }
          if (i < ids.length) {
            const outcome = (result.value as ExpireOutcome).outcome;
            tally.job[outcome] += 1;
            byJob.set(ids[i]!, Number(outcome === 'expired'));
          } else {
            const report = result.value as SweepReport;
            errors += report.failed;
            for (const [kind, n] of Object.entries(report.outcomes)) {
              tally.sweep[kind as ExpireOutcomeKind] += n;
            }
          }
        }
        // Per booking, not a round total: each of the 6 expired exactly once (job or sweep).
        const perBooking = ids.map((id) => ({
          job: byJob.get(id) ?? 0,
          sweep: who.sweepExpired(id),
        }));
        const mark = (b: { job: number; sweep: number }) =>
          b.job + b.sweep !== 1 ? `!${b.job + b.sweep}` : b.job ? 'J' : 'S';
        rows.push(`round ${String(round + 1).padStart(2)}: ${perBooking.map(mark).join(' ')}`);
        expect(perBooking.map((b) => b.job + b.sweep)).toEqual(ids.map(() => 1));
        expect(
          await db.prisma.booking.count({ where: { id: { in: ids }, status: 'EXPIRED' } }),
        ).toBe(ids.length);
        expect(await expiredStillHolding()).toBe(0);
      }

      console.info(
        `[2.10] job vs sweep, 20 rounds × 6 bookings: ${JSON.stringify(tally)}; ` +
          `errors ${errors}; deadlocks ${deadlocks}\n  (J = expired by its job, S = by a sweep)\n  ` +
          rows.join('\n  '),
      );
      expect(errors).toBe(0);
      expect(deadlocks).toBe(0);
      expect(tally.job.early).toBe(0);
      expect(tally.job.expired + tally.sweep.expired).toBe(120);
    });
  });

  // ─── Producer: after commit ───

  describe('enqueue after the hold commits', () => {
    it('adds expire-booking-<id> delayed until holdUntil (ClockService)', async () => {
      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1')]);

      const job = await app.get(BookingQueueProducer).queue.getJob(expireBookingJobId(booking.id));

      expect(job?.name).toBe('expire-booking');
      expect(job?.data).toEqual({ bookingId: booking.id });
      expect(job?.opts.delay).toBe(HOLD_MINUTES * 60_000);
      expect(await job?.getState()).toBe('delayed');
    });

    it('enqueuing the same booking twice keeps one job, whose id has no ":"', async () => {
      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1')]);
      const producer = app.get(BookingQueueProducer);

      // The hold enqueued it once; a retry (or a second API instance) enqueues it again.
      await producer.enqueueExpiry(booking.id, 1_000);

      const jobs = (await producer.queue.getJobs(['delayed', 'waiting', 'active'])).filter(
        (job) => (job.data as { bookingId?: string }).bookingId === booking.id,
      );
      expect(jobs.map((job) => job.id)).toEqual([`expire-booking-${booking.id}`]);
      expect(jobs[0]?.id).not.toContain(':');
      // The first one stays as it was: BullMQ ignores an add with an existing job id.
      expect(jobs[0]?.opts.delay).toBe(HOLD_MINUTES * 60_000);
    });

    it.each([
      [
        'refuses the job',
        () => Promise.reject(new Error('READONLY You can’t write against a read only replica.')),
      ],
      ['does not answer (1 s timeout)', () => new Promise<never>(() => undefined)],
    ])(
      'Redis %s: the hold still answers 201, the booking exists, an error is logged; the sweep expires it',
      async (_, add) => {
        const producer = app.get(BookingQueueProducer);
        jest.spyOn(producer.queue, 'add').mockImplementationOnce(add);
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const { seat, showtime: st } = await scene();

        const res = await hold(await newUser(), st.id, [seat('A1')]);

        expect(res.status).toBe(201);
        const booking = bodyOf<Booking>(res);
        expect(await bookingStatus(booking.id)).toBe('PENDING');
        expect(await producer.queue.getJob(expireBookingJobId(booking.id))).toBeUndefined();
        expect(errors).toHaveBeenCalledTimes(1);
        expect(String(errors.mock.calls[0]?.[0])).toContain(booking.id);

        // The safety net: once holdUntil is past, the sweep expires the booking.
        clock.advance({ minutes: HOLD_MINUTES });
        const report = await expiry.sweep();
        expect(report.outcomes.expired).toBeGreaterThanOrEqual(1);
        expect(await bookingStatus(booking.id)).toBe('EXPIRED');
        expect((await seatRow(st.id, seat('A1'))).status).toBe('AVAILABLE');
      },
    );
  });

  // ─── The real worker ───

  describe('worker', () => {
    /** Starts a worker like main.worker.ts does (QueueWorkers + processor), on the fake clock. */
    async function startWorker() {
      const ref = await workerModule();
      await ref.init();
      return { ref, workers: ref.get(QueueWorkers) };
    }

    /** Makes the delayed expire job of a booking due now. */
    async function promote(bookingId: string) {
      const job = await app.get(BookingQueueProducer).queue.getJob(expireBookingJobId(bookingId));
      if (!job) throw new Error(`No job for ${bookingId}`);
      await job.promote();
      return job;
    }

    /** Backend pids waiting on a row lock in this database. */
    async function lockWaiters(): Promise<number[]> {
      const rows = await db.prisma.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      return rows.map((row) => row.pid);
    }

    it('processes the expire-booking job the API enqueued (concurrency 5)', async () => {
      const { seat, showtime: st } = await scene();
      const bookings: Booking[] = [];
      for (const label of ['A1', 'A2', 'A3']) {
        bookings.push(await held(await newUser(), st.id, [seat(label)]));
      }
      clock.advance({ minutes: HOLD_MINUTES });
      const { ref, workers } = await startWorker();
      try {
        expect(workers['running'][0]?.worker.concurrency).toBe(5);
        for (const booking of bookings) await promote(booking.id);

        await eventually(async () =>
          (await Promise.all(bookings.map((b) => bookingStatus(b.id)))).every(
            (status) => status === 'EXPIRED',
          ),
        );
        for (const label of ['A1', 'A2', 'A3']) {
          expect((await seatRow(st.id, seat(label))).status).toBe('AVAILABLE');
        }
      } finally {
        await workers.closeAll(5_000);
        await ref.close();
      }
    });

    it('shutdown waits for a running job: it completes, booking EXPIRED and its seats released', async () => {
      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1'), seat('A2')]);
      clock.advance({ minutes: HOLD_MINUTES });
      const blocker = await lockSeat(st.id, seat('A2'));
      const { ref, workers } = await startWorker();
      try {
        const job = await promote(booking.id);
        await eventually(async () => (await lockWaiters()).length > 0);
        expect(await job.getState()).toBe('active');

        // SIGTERM arrives while the job waits on the seat lock; the lock goes 300 ms later.
        const closing = workers.closeAll(5_000);
        await pause(300);
        await blocker.query('COMMIT');

        await expect(closing).resolves.toBe(true);
        expect(await bookingStatus(booking.id)).toBe('EXPIRED');
        expect((await seatRow(st.id, seat('A1'))).status).toBe('AVAILABLE');
        expect((await seatRow(st.id, seat('A2'))).status).toBe('AVAILABLE');
      } finally {
        await blocker.end();
        await ref.close();
      }
    });

    it('shutdown timeout: the unfinished job is rolled back, never EXPIRED with HELD seats; the sweep finishes it', async () => {
      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1'), seat('A2')]);
      clock.advance({ minutes: HOLD_MINUTES });
      const blocker = await lockSeat(st.id, seat('A2'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { ref, workers } = await startWorker();
      try {
        await promote(booking.id);
        await eventually(async () => (await lockWaiters()).length > 0);
        const [waiter] = await lockWaiters();

        await expect(workers.closeAll(500)).resolves.toBe(false);
        expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toMatch(
          /still running after 500ms/,
        );

        // The worker process dies here (kill after the timeout): its transaction is rolled back.
        await db.prisma.$queryRaw`SELECT pg_terminate_backend(${waiter}::int)`;
        await blocker.query('COMMIT');
        await eventually(async () => (await lockWaiters()).length === 0);

        expect(await bookingStatus(booking.id)).toBe('PENDING');
        expect((await seatRow(st.id, seat('A1'))).status).toBe('HELD');
        expect(await expiredStillHolding()).toBe(0);

        // Next worker run: the per-minute sweep (or the job, once its lock expires) expires it.
        await expiry.sweep();
        expect(await bookingStatus(booking.id)).toBe('EXPIRED');
        expect((await seatRow(st.id, seat('A2'))).status).toBe('AVAILABLE');
        expect(await expiredStillHolding()).toBe(0);
      } finally {
        await blocker.end().catch(() => undefined);
        await ref.close().catch(() => undefined);
      }
    });
  });

  // ─── Reads ───

  describe('GET /bookings/:id', () => {
    it('the owner gets seats, combos, status, deadlines and totals; expired=false while held', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const booking = await held(user, st.id, [seat('A1')]);

      const res = await get(user, `/bookings/${booking.id}`);

      expect(res.status).toBe(200);
      expect(bodyOf<Booking>(res)).toEqual({ ...booking, expired: false });
      expect(booking).toMatchObject({
        status: 'PENDING',
        expiresAt: '2026-11-01T10:10:00.000Z',
        holdUntil: '2026-11-01T10:15:00.000Z',
        combos: [],
        expired: false,
      });
      expect(booking.seats.map((s) => s.label)).toEqual(['A1']);
      expect(booking.total).toBe(booking.subtotal);
    });

    it('carries the movie, the showtime and the room, also with no combo', async () => {
      const { seat, showtime: st, room: r } = await scene();
      const user = await newUser();
      const booking = await held(user, st.id, [seat('A1')]);
      const film = await db.prisma.movie.findUniqueOrThrow({ where: { id: st.movie.id } });

      const res = await get(user, `/bookings/${booking.id}`);

      expect(res.status).toBe(200);
      expect(bodyOf<Booking>(res)).toMatchObject({
        showtimeId: st.id,
        movie: { id: film.id, title: film.title, slug: film.slug },
        showtime: { id: st.id, startsAt: st.startsAt, endsAt: st.endsAt },
        room: { id: r.id, name: r.name },
        combos: [],
      });
      // The hold answers the same view.
      expect(booking).toEqual({ ...bodyOf<Booking>(res), expired: false });
    });

    it('404 BOOKING_NOT_FOUND for another user’s booking and for an unknown id; 400 for a bad id', async () => {
      const { seat, showtime: st } = await scene();
      const booking = await held(await newUser(), st.id, [seat('A1')]);
      const stranger = await newUser();

      for (const id of [booking.id, UNKNOWN_ID]) {
        const res = await get(stranger, `/bookings/${id}`);
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('BOOKING_NOT_FOUND');
      }
      const bad = await get(stranger, '/bookings/not-a-uuid');
      expect(bad.status).toBe(400);
      expect(errorOf(bad).code).toBe('VALIDATION_FAILED');
      expect((await http().get(`/bookings/${booking.id}`)).status).toBe(401);
    });

    it('expired=true once holdUntil has passed, before any job ran; status stays PENDING', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const booking = await held(user, st.id, [seat('A1')]);

      clock.advance({ minutes: HOLD_MINUTES, ms: -1 });
      expect(bodyOf<Booking>(await get(user, `/bookings/${booking.id}`)).expired).toBe(false);
      clock.advance({ ms: 1 });
      user.token = tokenOf(user.id);
      expect(bodyOf<Booking>(await get(user, `/bookings/${booking.id}`))).toMatchObject({
        status: 'PENDING',
        expired: true,
      });

      await expiry.expire(booking.id);
      expect(bodyOf<Booking>(await get(user, `/bookings/${booking.id}`))).toMatchObject({
        status: 'EXPIRED',
        expired: false,
      });
    });
  });

  describe('GET /me/bookings', () => {
    it('only the user’s bookings, newest first, paginated and filtered by status', async () => {
      const user = await newUser();
      const other = await newUser();
      const created: Booking[] = [];
      for (let i = 0; i < 3; i++) {
        const { seat, showtime: st } = await scene();
        created.push(await held(user, st.id, [seat('A1')]));
        await held(other, st.id, [seat('A2')]);
        clock.advance({ seconds: 10 });
      }
      // The oldest is over: expired by its job.
      clock.advance({ minutes: HOLD_MINUTES });
      await expiry.expire(created[0]!.id);
      user.token = tokenOf(user.id);
      const newestFirst = [...created].reverse().map((b) => b.id);

      const page1 = bodyOf<Page<Booking>>(await get(user, '/me/bookings?pageSize=2'));
      const page2 = bodyOf<Page<Booking>>(await get(user, '/me/bookings?pageSize=2&page=2'));

      expect(page1).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect([...page1.items, ...page2.items].map((b) => b.id)).toEqual(newestFirst);
      expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      // The two still stored PENDING are past holdUntil too: flagged, status unchanged.
      expect(page1.items.map((b) => [b.status, b.expired])).toEqual([
        ['PENDING', true],
        ['PENDING', true],
      ]);

      const expired = bodyOf<Page<Booking>>(await get(user, '/me/bookings?status=EXPIRED'));
      expect(expired).toMatchObject({ total: 1, page: 1, pageSize: 10 });
      expect(expired.items.map((b) => [b.id, b.status, b.expired])).toEqual([
        [created[0]!.id, 'EXPIRED', false],
      ]);

      const pending = bodyOf<Page<Booking>>(await get(user, '/me/bookings?status=PENDING'));
      expect(pending.total).toBe(2);
    });

    it('each item carries movie, showtime and room; the query count does not grow with the page (no N+1)', async () => {
      const user = await newUser();
      const scenes = [];
      for (let i = 0; i < 3; i++) {
        const sc = await scene();
        await held(user, sc.showtime.id, [sc.seat('A1'), sc.seat('A2')]);
        scenes.push(sc);
      }
      /** SQL statements sent to Postgres while answering `path`. */
      const statementsFor = async (path: string) => {
        const sent = jest.spyOn(Client.prototype, 'query');
        const res = await get(user, path);
        const count = sent.mock.calls.length;
        sent.mockRestore();
        expect(res.status).toBe(200);
        return { count, page: bodyOf<Page<Booking>>(res) };
      };

      const one = await statementsFor('/me/bookings?pageSize=1');
      const three = await statementsFor('/me/bookings?pageSize=3');

      expect(three.page.items).toHaveLength(3);
      expect(three.count).toBe(one.count);
      for (const item of three.page.items) {
        const sc = scenes.find((x) => x.showtime.id === item.showtimeId)!;
        expect(item.movie).toEqual({
          id: sc.showtime.movie.id,
          title: sc.showtime.movie.title,
          slug: sc.showtime.movie.slug,
        });
        expect(item.showtime).toEqual({
          id: sc.showtime.id,
          startsAt: sc.showtime.startsAt,
          endsAt: sc.showtime.endsAt,
        });
        expect(item.room).toEqual({ id: sc.room.id, name: sc.room.name });
        expect(item.seats.map((x) => x.label)).toEqual(['A1', 'A2']);
        expect(item.combos).toEqual([]);
      }
    });

    it('400 VALIDATION_FAILED for pageSize over 50, page 0 or an unknown status', async () => {
      const user = await newUser();
      for (const query of ['pageSize=51', 'pageSize=0', 'page=0', 'status=PAID']) {
        const res = await get(user, `/me/bookings?${query}`);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      const fifty = await get(user, '/me/bookings?pageSize=50');
      expect(fifty.status).toBe(200);
      expect(bodyOf<Page<Booking>>(fifty)).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
    });
  });

  // ─── Rate limit ───

  describe('POST /bookings rate limit', () => {
    it('11th request in a minute → 429 TOO_MANY_ATTEMPTS with retryAfterSeconds; another user is not affected', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        statuses.push((await hold(user, st.id, [seat('A1')])).status);
      }
      const before = await db.prisma.booking.count({ where: { showtimeId: st.id } });

      const blocked = await hold(user, st.id, [seat('A3')]);

      // The first creates the booking, the next 9 are refused by business rules — but counted.
      expect(statuses[0]).toBe(201);
      expect(statuses.slice(1).every((status) => status === 409)).toBe(true);
      expect(blocked.status).toBe(429);
      expect(errorOf(blocked).code).toBe('TOO_MANY_ATTEMPTS');
      const { retryAfterSeconds } = errorOf(blocked).details as { retryAfterSeconds: number };
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(60);
      // Exactly the time left in the window (the counter key's TTL in Redis).
      const key = `rl:booking:user:${user.id}`;
      expect(Math.abs(retryAfterSeconds - (await redis.client.ttl(key)))).toBeLessThanOrEqual(1);
      expect(await db.prisma.booking.count({ where: { showtimeId: st.id } })).toBe(before);

      const res = await hold(await newUser(), st.id, [seat('A3')]);
      expect(res.status).toBe(201);

      // End of the window (shortened, real Redis expiry): the user is allowed again.
      await redis.client.pexpire(key, 100);
      await eventually(async () => (await redis.client.exists(key)) === 0, 2_000);
      const again = await hold(user, st.id, [seat('A4')]);
      // Past the limiter, back to the business rules: A1 is still this user's live booking.
      expect(again.status).toBe(409);
      expect(errorOf(again).code).toBe('BOOKING_ALREADY_PENDING');
      expect(await redis.client.get(key)).toBe('1');
    });
  });
});
