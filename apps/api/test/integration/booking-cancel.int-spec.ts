import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type ClientToServerEvents,
  type CreatedShowtime,
  DayType,
  type JoinShowtimeAck,
  Role,
  SeatType,
  type ServerToClientEvents,
} from '@ticketify/shared';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../src/modules/bookings/booking-expiry.service';
import { setupRealtime } from '../../src/modules/realtime/realtime-io.adapter';
import { REALTIME_CHANNEL_KEY } from '../../src/modules/realtime/realtime-redis';
import { SeatEvents } from '../../src/modules/realtime/seat-events';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';
import { captureServerErrors, formatServerErrors } from '../support/server-errors';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
const HOLD_MINUTES = (HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS) / 60;
const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';
/** Longest a test waits for an event that must arrive (real time, Redis round trip). */
const EVENT_TIMEOUT_MS = 5_000;
const RACE_ROUNDS = 20;

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Deterministic PRNG (mulberry32) so a failing race round can be replayed. */
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

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type SeatEventName = 'seat:held' | 'seat:released' | 'seat:sold';

interface Received {
  event: SeatEventName;
  seatIds: string[];
}

/** Every seat event one socket received, in order. */
function recorder(socket: ClientSocket) {
  const events: Received[] = [];
  for (const event of ['seat:held', 'seat:released', 'seat:sold'] as const) {
    socket.on(event, (payload: { seatIds: string[] }) =>
      events.push({ event, seatIds: payload.seatIds }),
    );
  }
  return {
    /** Resolves once `count` events arrived; fails with what did arrive after the timeout. */
    async waitFor(count: number): Promise<Received[]> {
      for (let waited = 0; waited < EVENT_TIMEOUT_MS; waited += 20) {
        if (events.length >= count) return events;
        await pause(20);
      }
      throw new Error(`Expected ${count} events, got ${JSON.stringify(events)}`);
    },
  };
}

interface TestUser {
  id: string;
}

describe('Booking cancel — DELETE /bookings/:id (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let url: string;
  /** Worker side, compiled but not started: `BookingExpiryService` is called directly. */
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let adminToken: string;
  const clock = new FakeClock(NOW);
  /** Own channel prefix: Redis pub/sub ignores the logical database the suites are split into. */
  const channelKey = `ticketify-test:${randomUUID()}`;
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
          PAYMENT_GRACE_SECONDS: String(PAYMENT_GRACE_SECONDS),
        },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await setupRealtime(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: 90_000 })),
      ),
    });

    const { WorkerModule } = await import('../../src/worker.module.js');
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
    expiry = workerRef.get(BookingExpiryService);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await workerRef?.close();
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => clock.set(NOW));

  afterEach(() => {
    jest.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  /** Signed at the clock's current "now": tokens live 15 minutes on that clock. */
  const tokenOf = (user: TestUser) =>
    app.get(AccessTokenIssuer).issue({ id: user.id, role: Role.USER }).token;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `cancel-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Cancel User ${userCounter}`,
      },
    });
    return { id: user.id };
  }

  const hold = (user: TestUser, showtimeId: string, seatIds: string[]) =>
    http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });

  async function held(user: TestUser, showtimeId: string, seatIds: string[]): Promise<Booking> {
    const res = await hold(user, showtimeId, seatIds);
    expect(res.status).toBe(201);
    return bodyOf<Booking>(res);
  }

  const cancel = (user: TestUser, bookingId: string) =>
    http()
      .delete(`/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${tokenOf(user)}`);

  const admin = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', `Bearer ${adminToken}`).send(body);

  let movieId: string | undefined;
  let counter = 0;
  /** Fresh `rows × 12` room with one upcoming showtime; `seat('A1')` gives a seat id. */
  async function scene(rows = 2) {
    counter += 1;
    const roomRes = await admin('/admin/rooms', {
      name: `Phòng Cancel ${counter}`,
      rows,
      cols: 12,
    });
    expect(roomRes.status).toBe(201);
    const room = bodyOf<AdminRoom>(roomRes);
    const ids = new Map(room.seats.map((s) => [`${s.row}${s.number}`, s.id]));
    const seat = (label: string) => {
      const id = ids.get(label);
      if (!id) throw new Error(`No seat ${label}`);
      return id;
    };
    movieId ??= (
      await db.prisma.movie.create({
        data: {
          title: 'Cancel Movie',
          slug: `cancel-movie-${randomUUID()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: instant('2026-10-01'),
        },
      })
    ).id;
    const showtimeRes = await admin('/admin/showtimes', {
      movieId,
      roomId: room.id,
      startsAt: vn('2026-11-02', '19:00'),
    });
    expect(showtimeRes.status).toBe(201);
    return { showtime: bodyOf<CreatedShowtime>(showtimeRes), seat };
  }

  async function connect(): Promise<ClientSocket> {
    const socket: ClientSocket = io(url, {
      transports: ['websocket'],
      auth: { token: tokenOf(await newUser()) },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }

  const join = (socket: ClientSocket, showtimeId: string): Promise<JoinShowtimeAck> =>
    socket.timeout(EVENT_TIMEOUT_MS).emitWithAck('showtime:join', { showtimeId });

  const seatRows = (showtimeId: string) =>
    db.prisma.showtimeSeat.findMany({
      where: { showtimeId },
      select: { seatId: true, status: true, bookingId: true, heldUntil: true },
      orderBy: { seatId: 'asc' },
    });

  const bookingStatus = async (id: string) =>
    (await db.prisma.booking.findUniqueOrThrow({ where: { id } })).status;

  /** HELD seats whose booking is already EXPIRED: must never exist. */
  const heldByExpired = () =>
    db.prisma.$queryRaw<{ seat_id: string }[]>`
      SELECT ss.seat_id FROM showtime_seats ss JOIN bookings b ON b.id = ss.booking_id
      WHERE ss.status = 'HELD' AND b.status = 'EXPIRED'`;

  const deadlocks = async () => {
    const [row] = await db.prisma.$queryRaw<{ deadlocks: number }[]>`
      SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    return row?.deadlocks ?? 0;
  };

  // ─── Happy path ───

  describe('PENDING → EXPIRED', () => {
    it('204: booking EXPIRED, its seats AVAILABLE with booking_id NULL, seat:released once', async () => {
      const { showtime, seat } = await scene();
      const socket = await connect();
      const received = recorder(socket);
      expect(await join(socket, showtime.id)).toEqual({ joined: true });
      const user = await newUser();
      const booking = await held(user, showtime.id, [seat('A2'), seat('A1')]);
      const other = await held(await newUser(), showtime.id, [seat('B1')]);

      const res = await cancel(user, booking.id);

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await bookingStatus(booking.id)).toBe('EXPIRED');
      const rows = await seatRows(showtime.id);
      expect(rows.filter((row) => row.status !== 'AVAILABLE')).toEqual([
        {
          seatId: seat('B1'),
          status: 'HELD',
          bookingId: other.id,
          heldUntil: instant(other.holdUntil),
        },
      ]);
      expect(rows.every((row) => row.status !== 'AVAILABLE' || row.bookingId === null)).toBe(true);
      expect(rows.every((row) => row.status !== 'AVAILABLE' || row.heldUntil === null)).toBe(true);
      // The seats are free for the next customer at once, long before holdUntil.
      await held(await newUser(), showtime.id, [seat('A1')]);

      const events = await received.waitFor(4);
      expect(events).toEqual([
        { event: 'seat:held', seatIds: [seat('A1'), seat('A2')].sort() },
        { event: 'seat:held', seatIds: [seat('B1')] },
        { event: 'seat:released', seatIds: [seat('A1'), seat('A2')].sort() },
        { event: 'seat:held', seatIds: [seat('A1')] },
      ]);
    });

    it('twice: 204 both times, the second changes nothing and sends nothing', async () => {
      const { showtime, seat } = await scene();
      const socket = await connect();
      const received = recorder(socket);
      await join(socket, showtime.id);
      const user = await newUser();
      const booking = await held(user, showtime.id, [seat('A1')]);

      expect((await cancel(user, booking.id)).status).toBe(204);
      const after = await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      clock.advance({ minutes: 1 });
      expect((await cancel(user, booking.id)).status).toBe(204);
      // Untouched by the second call: updated_at still the first cancel's.
      expect(await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(
        after,
      );
      // Barrier: an event sent after both cancels.
      await held(await newUser(), showtime.id, [seat('A2')]);

      const events = await received.waitFor(3);
      await pause(200);
      expect(events.map((e) => e.event)).toEqual(['seat:held', 'seat:released', 'seat:held']);
    });

    it('a booking already EXPIRED by the worker: 204, nothing changes, nothing sent', async () => {
      const { showtime, seat } = await scene();
      const user = await newUser();
      const booking = await held(user, showtime.id, [seat('A1')]);
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
      const released = jest.spyOn(app.get(SeatEvents), 'released');

      expect((await cancel(user, booking.id)).status).toBe(204);
      expect(await bookingStatus(booking.id)).toBe('EXPIRED');
      expect(released).not.toHaveBeenCalled();
    });

    it('past holdUntil, after another booking took one of its seats: only its own seats are released', async () => {
      const { showtime, seat } = await scene();
      const user = await newUser();
      const stale = await held(user, showtime.id, [seat('A1'), seat('A2')]);
      clock.advance({ minutes: HOLD_MINUTES });
      // Lazy expiry: A2 is free for the next customer before any job ran.
      const taker = await held(await newUser(), showtime.id, [seat('A2')]);
      const released = jest.spyOn(app.get(SeatEvents), 'released');

      expect((await cancel(user, stale.id)).status).toBe(204);

      expect(await bookingStatus(stale.id)).toBe('EXPIRED');
      expect(await seatRows(showtime.id)).toEqual(
        expect.arrayContaining([
          { seatId: seat('A1'), status: 'AVAILABLE', bookingId: null, heldUntil: null },
          {
            seatId: seat('A2'),
            status: 'HELD',
            bookingId: taker.id,
            heldUntil: instant(taker.holdUntil),
          },
        ]),
      );
      expect(released.mock.calls).toEqual([[showtime.id, [seat('A1')]]]);
    });
  });

  // ─── Refusals ───

  describe('refusals', () => {
    it('404 BOOKING_NOT_FOUND for another user’s booking and an unknown id; nothing changes', async () => {
      const { showtime, seat } = await scene();
      const owner = await newUser();
      const booking = await held(owner, showtime.id, [seat('A1')]);
      const before = await seatRows(showtime.id);
      const intruder = await newUser();

      for (const res of [await cancel(intruder, booking.id), await cancel(owner, UNKNOWN_ID)]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('BOOKING_NOT_FOUND');
      }
      expect(await bookingStatus(booking.id)).toBe('PENDING');
      expect(await seatRows(showtime.id)).toEqual(before);
    });

    it('400 VALIDATION_FAILED for a malformed id, 401 without a token', async () => {
      const user = await newUser();
      const bad = await cancel(user, 'not-a-uuid');
      expect(bad.status).toBe(400);
      expect(errorOf(bad).code).toBe('VALIDATION_FAILED');
      expect((await http().delete(`/bookings/${UNKNOWN_ID}`)).status).toBe(401);
    });

    it.each(['CONFIRMED', 'NEEDS_REVIEW'] as const)(
      '409 BOOKING_NOT_CANCELLABLE for a %s booking; nothing changes',
      async (status) => {
        const { showtime, seat } = await scene();
        const user = await newUser();
        const booking = await held(user, showtime.id, [seat('A1')]);
        // The state payment (phase 3) will leave behind, written directly.
        await db.prisma.$executeRaw`
          UPDATE bookings SET status = ${status}::booking_status WHERE id = ${booking.id}::uuid`;
        await db.prisma.$executeRaw`
          UPDATE showtime_seats SET status = 'SOLD', held_until = NULL
          WHERE booking_id = ${booking.id}::uuid`;
        const before = await seatRows(showtime.id);
        const released = jest.spyOn(app.get(SeatEvents), 'released');

        const res = await cancel(user, booking.id);

        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('BOOKING_NOT_CANCELLABLE');
        expect(await bookingStatus(booking.id)).toBe(status);
        expect(await seatRows(showtime.id)).toEqual(before);
        expect(released).not.toHaveBeenCalled();
      },
    );
  });

  // ─── Concurrency ───

  describe('concurrency', () => {
    it(`cancel vs expireBooking vs another user's hold, ${RACE_ROUNDS} rounds: no 5xx, no deadlock, one final state each`, async () => {
      const next = random(20_261_110);
      // One showtime, three seats of its own per round: rounds never share a seat.
      const { showtime, seat } = await scene(5);
      const labels = ['A', 'B', 'C', 'D', 'E'].flatMap((row) =>
        Array.from({ length: 12 }, (_, i) => `${row}${i + 1}`),
      );
      const server = captureServerErrors();
      const apiReleased = jest.spyOn(app.get(SeatEvents), 'released');
      const workerReleased = jest.spyOn(workerRef.get(SeatEvents), 'released');
      const deadlocksBefore = await deadlocks();
      const outcomes = new Map<string, number>();

      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          clock.set(NOW);
          apiReleased.mockClear();
          workerReleased.mockClear();
          const [s1, s2, s3] = labels.slice(round * 3, round * 3 + 3).map(seat) as [
            string,
            string,
            string,
          ];
          const owner = await newUser();
          const rival = await newUser();
          const booking = await held(owner, showtime.id, [s1, s2]);
          // Half the rounds run while the hold is live (the expiry is "early", the rival can only
          // get s2 once the cancel has committed), half past holdUntil (the expiry really expires,
          // the rival may take s2 by lazy expiry before either of them).
          const overdue = next() < 0.5;
          if (overdue) clock.advance({ minutes: HOLD_MINUTES });
          const delays = [0, 0, 0].map(() => Math.floor(next() * 6));

          const [cancelled, expired, rivalHold] = await Promise.all([
            pause(delays[0]!).then(() => cancel(owner, booking.id)),
            pause(delays[1]!).then(() => expiry.expire(booking.id)),
            pause(delays[2]!).then(() => hold(rival, showtime.id, [s2, s3])),
          ]);
          const rivalLabel =
            rivalHold.status === 201 ? '201' : `${rivalHold.status} ${errorOf(rivalHold).code}`;
          const label = `${overdue ? 'overdue' : 'live'}: expire ${expired.outcome} / rival ${rivalLabel}`;
          outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
          expect(formatServerErrors(server.errors)).toBe('');

          expect(cancelled.status).toBe(204);
          expect(overdue ? ['expired', 'noop', 'skipped'] : ['early', 'noop', 'skipped']).toContain(
            expired.outcome,
          );
          expect([201, 409]).toContain(rivalHold.status);
          if (rivalHold.status === 409) {
            expect(['SEAT_LOCKED', 'SEAT_UNAVAILABLE']).toContain(errorOf(rivalHold).code);
          }

          // One final state per booking.
          expect(await bookingStatus(booking.id)).toBe('EXPIRED');
          const rows = new Map((await seatRows(showtime.id)).map((row) => [row.seatId, row]));
          const rivalBooking = rivalHold.status === 201 ? bodyOf<Booking>(rivalHold) : null;
          if (rivalBooking) {
            expect(await bookingStatus(rivalBooking.id)).toBe('PENDING');
            for (const id of [s2, s3]) {
              expect(rows.get(id)).toMatchObject({ status: 'HELD', bookingId: rivalBooking.id });
            }
            expect(rows.get(s1)).toMatchObject({ status: 'AVAILABLE', bookingId: null });
          } else {
            expect(await db.prisma.booking.count({ where: { userId: rival.id } })).toBe(0);
            for (const id of [s1, s2, s3]) {
              expect(rows.get(id)).toMatchObject({ status: 'AVAILABLE', bookingId: null });
            }
          }
          expect(await heldByExpired()).toEqual([]);

          // Each of the booking's seats is announced released at most once, and only if it was
          // really given back (not taken over by the rival through lazy expiry first).
          const announced = [...apiReleased.mock.calls, ...workerReleased.mock.calls].flatMap(
            ([, seatIds]) => [...seatIds],
          );
          expect(new Set(announced).size).toBe(announced.length);
          expect([s1, s2]).toEqual(expect.arrayContaining(announced));
          expect(announced).toContain(s1);
          if (!rivalBooking) expect(announced).toContain(s2);
        }

        // Backends report their statistics with a delay; give them a moment before reading.
        await pause(1_500);
        const found = (await deadlocks()) - deadlocksBefore;
        console.info(
          `[cancel] ${RACE_ROUNDS} rounds: ${JSON.stringify(Object.fromEntries(outcomes))}; deadlocks ${found}`,
        );
        expect(found).toBe(0);
      } finally {
        server.restore();
      }
    }, 60_000);
  });
});
