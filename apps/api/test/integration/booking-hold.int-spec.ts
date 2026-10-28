import { randomUUID } from 'node:crypto';
import { Agent } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  DayType,
  type FieldError,
  Role,
  SeatType,
} from '@ticketify/shared';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { requestHash } from '../../src/modules/bookings/request-hash';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
/** Large enough for 500 simultaneous holds; several suites share one Postgres (max 100). */
const POOL_MAX = 40;
const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';

const PRICES: Record<SeatType, Record<DayType, number>> = {
  STANDARD: { WEEKDAY: 75_000, WEEKEND: 90_000, HOLIDAY: 110_000 },
  VIP: { WEEKDAY: 95_000, WEEKEND: 115_000, HOLIDAY: 135_000 },
  COUPLE: { WEEKDAY: 100_000, WEEKEND: 120_000, HOLIDAY: 145_000 },
};

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string | number): Date => new FakeClock(value).now();
const plusMinutes = (value: string, minutes: number): string =>
  instant(instant(value).getTime() + minutes * 60_000).toISOString();

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

interface TestUser {
  id: string;
  token: string;
}

interface HoldBody {
  showtimeId: string;
  seatIds: string[];
  comboItems?: { comboId: string; quantity: number }[];
}

describe('Seat hold — POST /bookings (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let adminToken: string;
  const clock = new FakeClock(NOW);

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
          // Many holds per user here; the limit itself is covered in booking-expiry.int-spec.
          BOOKING_RATE_LIMIT_MAX: '1000',
        },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    // A real port so concurrent supertest requests share one server.
    await app.listen(0, '127.0.0.1');
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(async () => {
    clock.set(NOW);
    // Reset every time: the snapshot test changes the price table.
    await db.prisma.seatPrice.deleteMany();
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({
          seatType,
          dayType,
          price: PRICES[seatType][dayType],
        })),
      ),
    });
  });

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());

  /** Access token signed at the clock's current "now" (tokens live 15 minutes on that clock). */
  const tokenOf = (id: string) => app.get(AccessTokenIssuer).issue({ id, role: Role.USER }).token;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `hold-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Hold User ${userCounter}`,
      },
    });
    return { id: user.id, token: tokenOf(user.id) };
  }

  const hold = (
    user: TestUser,
    body: HoldBody,
    key: string | null = randomUUID(),
    agent?: Agent,
  ) => {
    const req = http().post('/bookings').set('Authorization', `Bearer ${user.token}`);
    if (agent) req.agent(agent);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  const admin = (method: 'post' | 'patch', path: string, body?: object) =>
    http()[method](path).set('Authorization', `Bearer ${adminToken}`).send(body);

  let roomCounter = 0;
  /**
   * 2×5 room: A1–A5 STANDARD, B1–B2 VIP, B3+B4 a couple pair, B5 switched off.
   * `seat('A1')` gives the seat id.
   */
  async function room(): Promise<{ room: AdminRoom; seat: (label: string) => string }> {
    roomCounter += 1;
    const created = await admin('post', '/admin/rooms', {
      name: `Phòng Hold ${roomCounter}`,
      rows: 2,
      cols: 5,
    });
    expect(created.status).toBe(201);
    const ids = new Map<string, string>(
      bodyOf<AdminRoom>(created).seats.map((s) => [`${s.row}${s.number}`, s.id]),
    );
    const seat = (label: string) => {
      const id = ids.get(label);
      if (!id) throw new Error(`No seat ${label}`);
      return id;
    };
    const edited = await admin('patch', `/admin/rooms/${bodyOf<AdminRoom>(created).id}/seats`, {
      changes: [
        { seatId: seat('B1'), type: 'VIP' },
        { seatId: seat('B2'), type: 'VIP' },
        { seatId: seat('B3'), type: 'COUPLE', coupleWith: seat('B4') },
        { seatId: seat('B4'), type: 'COUPLE', coupleWith: seat('B3') },
        { seatId: seat('B5'), isActive: false },
      ],
    });
    expect(edited.status).toBe(200);
    return { room: bodyOf<AdminRoom>(edited), seat };
  }

  let movieId: string | undefined;
  async function film(): Promise<string> {
    movieId ??= (
      await db.prisma.movie.create({
        data: {
          title: 'Hold Movie',
          slug: `hold-movie-${randomUUID()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: instant('2026-10-01'),
        },
      })
    ).id;
    return movieId;
  }

  /** A showtime on Monday 2026-11-02 (WEEKDAY prices) at `time` in Vietnam. */
  async function showtime(roomId: string, time = '19:00', date = '2026-11-02') {
    const res = await admin('post', '/admin/showtimes', {
      movieId: await film(),
      roomId,
      startsAt: vn(date, time),
    });
    expect(res.status).toBe(201);
    return bodyOf<CreatedShowtime>(res);
  }

  /** Fresh room + one upcoming showtime. */
  async function scene() {
    const { room: r, seat } = await room();
    const st = await showtime(r.id);
    return { room: r, seat, showtime: st };
  }

  const seatRows = (showtimeId: string) =>
    db.prisma.showtimeSeat.findMany({
      where: { showtimeId },
      select: { seatId: true, status: true, bookingId: true, heldUntil: true, price: true },
    });

  async function seatRow(showtimeId: string, seatId: string) {
    return db.prisma.showtimeSeat.findUniqueOrThrow({
      where: { showtimeId_seatId: { showtimeId, seatId } },
    });
  }

  /** Marks a seat SOLD for a booking of some other user, the way payment (phase 3) will. */
  async function sell(showtimeId: string, seatId: string) {
    const other = await newUser();
    const res = await hold(other, { showtimeId, seatIds: [seatId] });
    expect(res.status).toBe(201);
    await db.prisma.showtimeSeat.update({
      where: { showtimeId_seatId: { showtimeId, seatId } },
      data: { status: 'SOLD', heldUntil: null },
    });
  }

  async function combo(name: string, price: number, isActive = true) {
    return db.prisma.combo.create({ data: { name: `${name} ${randomUUID()}`, price, isActive } });
  }

  const bookingCount = (showtimeId: string) => db.prisma.booking.count({ where: { showtimeId } });

  // ─── Happy path ───

  describe('hold', () => {
    it('201: seats HELD until holdUntil by the new PENDING booking, at the locked prices', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const seatIds = [seat('B1'), seat('A2')];

      const res = await hold(user, { showtimeId: st.id, seatIds });

      expect(res.status).toBe(201);
      const booking = bodyOf<Booking>(res);
      expect(booking).toMatchObject({
        showtimeId: st.id,
        status: 'PENDING',
        expiresAt: '2026-11-01T10:10:00.000Z',
        holdUntil: '2026-11-01T10:15:00.000Z',
        createdAt: NOW,
        subtotal: PRICES.STANDARD.WEEKDAY + PRICES.VIP.WEEKDAY,
        discount: 0,
        total: PRICES.STANDARD.WEEKDAY + PRICES.VIP.WEEKDAY,
        combos: [],
      });
      expect(booking.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
      // Seats by row then number, each at the price locked into the showtime.
      expect(booking.seats.map((s) => [s.label, s.type, s.price])).toEqual([
        ['A2', 'STANDARD', PRICES.STANDARD.WEEKDAY],
        ['B1', 'VIP', PRICES.VIP.WEEKDAY],
      ]);

      const rows = await seatRows(st.id);
      const held = rows.filter((row) => row.status === 'HELD');
      expect(held.map((row) => row.seatId).sort()).toEqual([...seatIds].sort());
      for (const row of held) {
        expect(row.bookingId).toBe(booking.id);
        expect(row.heldUntil?.toISOString()).toBe(booking.holdUntil);
      }
      expect(rows.filter((row) => row.status !== 'AVAILABLE')).toHaveLength(2);

      const stored = await db.prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        include: { seats: true },
      });
      expect(stored).toMatchObject({ userId: user.id, status: 'PENDING', total: booking.total });
      expect(stored.seats.map((line) => [line.seatId, line.price]).sort()).toEqual(
        held.map((row) => [row.seatId, row.price]).sort(),
      );
    });

    it('401 without a token', async () => {
      const res = await http()
        .post('/bookings')
        .set('Idempotency-Key', randomUUID())
        .send({ showtimeId: UNKNOWN_ID, seatIds: [UNKNOWN_ID] });
      expect(res.status).toBe(401);
    });
  });

  // ─── Validation (400) ───

  describe('400 VALIDATION_FAILED', () => {
    const fieldsOf = (res: request.Response) =>
      (errorOf(res).details as FieldError[]).map((detail) => detail.field);

    it('seat count, repeated seats and malformed ids; nothing is written', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const all = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2'].map(seat);

      for (const seatIds of [all, [], [seat('A1'), seat('A1')], ['A1']]) {
        const res = await hold(user, { showtimeId: st.id, seatIds });
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        expect(fieldsOf(res)).toEqual(['seatIds']);
      }
      expect(await bookingCount(st.id)).toBe(0);
    });

    it('Idempotency-Key header: missing, too short, too long or with unsafe characters', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const body = { showtimeId: st.id, seatIds: [seat('A1')] };

      for (const key of [null, 'short', 'x'.repeat(129), 'has space!', 'semi;colon-key']) {
        const res = await hold(user, body, key);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        expect(fieldsOf(res)).toEqual(['Idempotency-Key']);
      }
      expect(await bookingCount(st.id)).toBe(0);
    });
  });

  // ─── Seats ───

  describe('seat state', () => {
    it('409 SEAT_UNAVAILABLE for a SOLD seat', async () => {
      const { seat, showtime: st } = await scene();
      await sell(st.id, seat('A1'));

      const res = await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A1')] });

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'SEAT_UNAVAILABLE',
        details: { seatIds: [seat('A1')] },
      });
    });

    it('409 SEAT_UNAVAILABLE for a live hold, listing only the conflicting seats; all or nothing', async () => {
      const { seat, showtime: st } = await scene();
      expect(
        (await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A2'), seat('A4')] }))
          .status,
      ).toBe(201);
      clock.advance({ seconds: HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS - 1 });

      const res = await hold(await newUser(), {
        showtimeId: st.id,
        seatIds: [seat('A1'), seat('A2'), seat('A3'), seat('A4')],
      });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SEAT_UNAVAILABLE');
      expect((errorOf(res).details as { seatIds: string[] }).seatIds.sort()).toEqual(
        [seat('A2'), seat('A4')].sort(),
      );
      // A1 and A3 were not taken either.
      expect((await seatRow(st.id, seat('A1'))).status).toBe('AVAILABLE');
      expect((await seatRow(st.id, seat('A3'))).status).toBe('AVAILABLE');
      expect(await bookingCount(st.id)).toBe(1);
    });

    it('an expired hold (held_until <= now) is free: another user takes the seat', async () => {
      const { seat, showtime: st } = await scene();
      const first = await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A1')] });
      expect(first.status).toBe(201);

      clock.advance({ seconds: HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS }); // exactly holdUntil
      const res = await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A1')] });

      expect(res.status).toBe(201);
      const second = bodyOf<Booking>(res);
      expect(second.holdUntil).toBe(plusMinutes(NOW, 30));
      const row = await seatRow(st.id, seat('A1'));
      expect(row).toMatchObject({ status: 'HELD', bookingId: second.id });
      expect(row.heldUntil?.toISOString()).toBe(second.holdUntil);
      // The first booking is left PENDING for the expiry job (week 8); its seat line stays.
      const old = await db.prisma.booking.findUniqueOrThrow({
        where: { id: bodyOf<Booking>(first).id },
        include: { seats: true },
      });
      expect(old.status).toBe('PENDING');
      expect(old.seats).toHaveLength(1);
    });

    it('422 SEAT_NOT_FOUND for a seat of another room, a switched-off seat or an unknown id', async () => {
      const { seat, showtime: st } = await scene();
      const other = await room();
      const user = await newUser();

      for (const missing of [other.seat('A1'), seat('B5'), UNKNOWN_ID]) {
        const res = await hold(user, { showtimeId: st.id, seatIds: [seat('A1'), missing] });
        expect(res.status).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'SEAT_NOT_FOUND',
          details: { seatIds: [missing] },
        });
      }
      expect(await bookingCount(st.id)).toBe(0);
    });

    it('422 COUPLE_INCOMPLETE without the partner; the full pair is held at the COUPLE price', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();

      const half = await hold(user, { showtimeId: st.id, seatIds: [seat('B3'), seat('A1')] });
      expect(half.status).toBe(422);
      expect(errorOf(half)).toMatchObject({
        code: 'COUPLE_INCOMPLETE',
        details: { missingSeatIds: [seat('B4')] },
      });
      expect(await bookingCount(st.id)).toBe(0);

      const pair = await hold(user, { showtimeId: st.id, seatIds: [seat('B4'), seat('B3')] });
      expect(pair.status).toBe(201);
      expect(bodyOf<Booking>(pair).seats.map((s) => [s.label, s.price])).toEqual([
        ['B3', PRICES.COUPLE.WEEKDAY],
        ['B4', PRICES.COUPLE.WEEKDAY],
      ]);
    });
  });

  // ─── Showtime ───

  describe('showtime state', () => {
    it('409 SHOWTIME_CANCELLED', async () => {
      const { seat, showtime: st } = await scene();
      expect((await admin('post', `/admin/showtimes/${st.id}/cancel`)).status).toBe(200);

      const res = await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A1')] });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SHOWTIME_CANCELLED');
      expect(await bookingCount(st.id)).toBe(0);
    });

    it('422 SHOWTIME_STARTED from startsAt on, although the seat map is still served', async () => {
      const { seat, showtime: st } = await scene();
      clock.set(st.startsAt);
      const user = await newUser();

      const res = await hold(user, { showtimeId: st.id, seatIds: [seat('A1')] });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('SHOWTIME_STARTED');
      expect((await http().get(`/showtimes/${st.id}/seats`)).status).toBe(200);
      expect(await bookingCount(st.id)).toBe(0);
    });

    it('404 SHOWTIME_NOT_FOUND for an unknown showtime', async () => {
      const res = await hold(await newUser(), { showtimeId: UNKNOWN_ID, seatIds: [UNKNOWN_ID] });
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('SHOWTIME_NOT_FOUND');
    });
  });

  // ─── One PENDING booking per user per showtime ───

  describe('one live PENDING booking per user per showtime', () => {
    it('409 BOOKING_ALREADY_PENDING for a second hold; other showtimes and other users are fine', async () => {
      const { room: r, seat, showtime: st } = await scene();
      const later = await showtime(r.id, '22:00');
      const user = await newUser();
      const first = await hold(user, { showtimeId: st.id, seatIds: [seat('A1')] });
      expect(first.status).toBe(201);

      const second = await hold(user, { showtimeId: st.id, seatIds: [seat('A2')] });
      expect(second.status).toBe(409);
      expect(errorOf(second)).toMatchObject({
        code: 'BOOKING_ALREADY_PENDING',
        details: { bookingId: bodyOf<Booking>(first).id },
      });
      expect((await seatRow(st.id, seat('A2'))).status).toBe('AVAILABLE');

      expect((await hold(user, { showtimeId: later.id, seatIds: [seat('A2')] })).status).toBe(201);
      expect(
        (await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A2')] })).status,
      ).toBe(201);
    });

    it('a PENDING booking past its expiresAt does not count (it can no longer be paid)', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      expect((await hold(user, { showtimeId: st.id, seatIds: [seat('A1')] })).status).toBe(201);

      clock.advance({ seconds: HOLD_TTL_SECONDS - 1 });
      user.token = tokenOf(user.id);
      expect((await hold(user, { showtimeId: st.id, seatIds: [seat('A2')] })).status).toBe(409);

      clock.advance({ seconds: 1 });
      const res = await hold(user, { showtimeId: st.id, seatIds: [seat('A2')] });
      expect(res.status).toBe(201);
      expect(await bookingCount(st.id)).toBe(2);
    });
  });

  // ─── Combos and price snapshot ───

  describe('combos and price snapshot', () => {
    it('subtotal = seats + combo lines; name and unit price are copied', async () => {
      const { seat, showtime: st } = await scene();
      const popcorn = await combo('Bắp lớn', 79_000);
      const drink = await combo('Nước ngọt', 35_000);

      const res = await hold(await newUser(), {
        showtimeId: st.id,
        seatIds: [seat('A1'), seat('B1')],
        comboItems: [
          { comboId: popcorn.id, quantity: 2 },
          { comboId: drink.id, quantity: 3 },
        ],
      });

      expect(res.status).toBe(201);
      const booking = bodyOf<Booking>(res);
      const seats = PRICES.STANDARD.WEEKDAY + PRICES.VIP.WEEKDAY;
      expect(booking).toMatchObject({
        subtotal: seats + 2 * 79_000 + 3 * 35_000,
        discount: 0,
        total: seats + 2 * 79_000 + 3 * 35_000,
      });
      expect(
        booking.combos.map((c) => [c.comboId, c.name, c.unitPrice, c.quantity, c.amount]).sort(),
      ).toEqual(
        [
          [popcorn.id, popcorn.name, 79_000, 2, 158_000],
          [drink.id, drink.name, 35_000, 3, 105_000],
        ].sort(),
      );
    });

    it('422 COMBO_NOT_AVAILABLE for a switched-off or unknown combo; nothing is held', async () => {
      const { seat, showtime: st } = await scene();
      const off = await combo('Combo tắt', 50_000, false);
      const on = await combo('Combo bật', 50_000);
      const user = await newUser();

      for (const comboId of [off.id, UNKNOWN_ID]) {
        const res = await hold(user, {
          showtimeId: st.id,
          seatIds: [seat('A1')],
          comboItems: [
            { comboId: on.id, quantity: 1 },
            { comboId, quantity: 1 },
          ],
        });
        expect(res.status).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'COMBO_NOT_AVAILABLE',
          details: { comboIds: [comboId] },
        });
      }
      expect(await bookingCount(st.id)).toBe(0);
      expect((await seatRow(st.id, seat('A1'))).status).toBe('AVAILABLE');
    });

    it('later SeatPrice and Combo edits never change an existing booking', async () => {
      const { seat, showtime: st } = await scene();
      const popcorn = await combo('Bắp phô mai', 69_000);
      const user = await newUser();
      const key = randomUUID();
      const body = {
        showtimeId: st.id,
        seatIds: [seat('A1')],
        comboItems: [{ comboId: popcorn.id, quantity: 1 }],
      };
      const created = bodyOf<Booking>(await hold(user, body, key));

      await db.prisma.seatPrice.updateMany({ data: { price: 999_000 } });
      await db.prisma.showtimeSeat.updateMany({
        where: { showtimeId: st.id },
        data: { price: 888_000 },
      });
      await db.prisma.combo.update({
        where: { id: popcorn.id },
        data: { name: 'Đổi tên', price: 1_000, isActive: false },
      });

      // Replaying the same request returns the booking as stored.
      const again = await hold(user, body, key);
      expect(again.status).toBe(200);
      expect(bodyOf<Booking>(again)).toEqual(created);
      expect(created.seats[0]?.price).toBe(PRICES.STANDARD.WEEKDAY);
      expect(created.combos[0]).toMatchObject({ name: popcorn.name, unitPrice: 69_000 });
      expect(created.total).toBe(PRICES.STANDARD.WEEKDAY + 69_000);
      const lines = await db.prisma.bookingSeat.findMany({ where: { bookingId: created.id } });
      expect(lines.map((line) => line.price)).toEqual([PRICES.STANDARD.WEEKDAY]);
    });
  });

  // ─── Idempotency ───

  describe('Idempotency-Key', () => {
    it('same key + same payload (any order) → 200 with the same booking; nothing new is written', async () => {
      const { seat, showtime: st } = await scene();
      const popcorn = await combo('Bắp', 50_000);
      const drink = await combo('Nước', 30_000);
      const user = await newUser();
      const key = randomUUID();

      const first = await hold(
        user,
        {
          showtimeId: st.id,
          seatIds: [seat('A1'), seat('A2')],
          comboItems: [
            { comboId: popcorn.id, quantity: 1 },
            { comboId: drink.id, quantity: 2 },
          ],
        },
        key,
      );
      expect(first.status).toBe(201);
      clock.advance({ minutes: 1 });

      const again = await hold(
        user,
        {
          comboItems: [
            { quantity: 2, comboId: drink.id.toUpperCase() },
            { quantity: 1, comboId: popcorn.id },
          ],
          seatIds: [seat('A2').toUpperCase(), seat('A1')],
          showtimeId: st.id,
        },
        key,
      );

      expect(again.status).toBe(200);
      expect(bodyOf<Booking>(again)).toEqual(bodyOf<Booking>(first));
      expect(await bookingCount(st.id)).toBe(1);
    });

    it('same key + different payload → 422 IDEMPOTENCY_KEY_REUSED; nothing is held', async () => {
      const { room: r, seat, showtime: st } = await scene();
      const later = await showtime(r.id, '22:00');
      const user = await newUser();
      const key = randomUUID();
      expect((await hold(user, { showtimeId: st.id, seatIds: [seat('A1')] }, key)).status).toBe(
        201,
      );

      for (const body of [
        { showtimeId: st.id, seatIds: [seat('A2')] },
        { showtimeId: st.id, seatIds: [seat('A1'), seat('A2')] },
        { showtimeId: later.id, seatIds: [seat('A1')] },
      ]) {
        const res = await hold(user, body, key);
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect((await seatRow(st.id, seat('A2'))).status).toBe('AVAILABLE');
      expect((await seatRow(later.id, seat('A1'))).status).toBe('AVAILABLE');
    });

    it('a key is per user: another user may use the same key', async () => {
      const { seat, showtime: st } = await scene();
      const key = randomUUID();
      const a = await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A1')] }, key);
      const b = await hold(await newUser(), { showtimeId: st.id, seatIds: [seat('A2')] }, key);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(bodyOf<Booking>(a).id).not.toBe(bodyOf<Booking>(b).id);
    });

    describe('losing the insert race on unique(user_id, idempotency_key)', () => {
      /**
       * Another transaction inserts the same (user, key) and stays open, so the request does not
       * see it, passes every check and blocks on the unique index. Once that transaction commits,
       * the request's insert fails with 23505 and it must answer from the committed booking.
       */
      async function race(storedHash: (body: HoldBody) => string) {
        const { seat, showtime: st } = await scene();
        const user = await newUser();
        const key = randomUUID();
        const body = { showtimeId: st.id, seatIds: [seat('A1')] };
        const competitor = randomUUID();

        const other = new Client({ connectionString: db.url });
        await other.connect();
        try {
          await other.query('BEGIN');
          await other.query(
            `INSERT INTO bookings (id, code, user_id, showtime_id, status, subtotal, total,
                                   expires_at, hold_until, idempotency_key, request_hash)
             VALUES ($1, $2, $3, $4, 'PENDING', 0, 0, $5, $5, $6, $7)`,
            [
              competitor,
              `RACE${randomUUID().slice(0, 6)}`,
              user.id,
              st.id,
              instant(plusMinutes(NOW, 15)),
              key,
              storedHash({ ...body, comboItems: [] }),
            ],
          );
          const pending = hold(user, body, key).then((res) => res);
          await waitForLockWait();
          await other.query('COMMIT');
          return { res: await pending, competitor, st, seatId: seat('A1') };
        } finally {
          await other.end();
        }
      }

      /** Until some backend of this database waits on a lock (the request's booking insert). */
      async function waitForLockWait() {
        for (let i = 0; i < 200; i++) {
          const [row] = await db.prisma.$queryRaw<{ waiting: number }[]>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if ((row?.waiting ?? 0) > 0) return;
          await pause(25);
        }
        throw new Error('The hold never blocked on the unique index');
      }

      const hashOf = (body: HoldBody) =>
        requestHash({ ...body, comboItems: body.comboItems ?? [] });

      it('same payload → 200 with the committed booking, the seat stays free', async () => {
        const { res, competitor, st, seatId } = await race(hashOf);

        expect(res.status).toBe(200);
        expect(bodyOf<Booking>(res).id).toBe(competitor);
        expect((await seatRow(st.id, seatId)).status).toBe('AVAILABLE');
        expect(await bookingCount(st.id)).toBe(1);
      });

      it('different payload → 422 IDEMPOTENCY_KEY_REUSED, not a 5xx', async () => {
        const { res, st, seatId } = await race(() => 'f'.repeat(64));

        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect((await seatRow(st.id, seatId)).status).toBe('AVAILABLE');
      });
    });
  });

  // ─── Lock compatibility the design relies on ───

  describe('lock conflict table (PLAN §4, ROADMAP 2.1)', () => {
    /**
     * Cancelling holds `showtimes` FOR NO KEY UPDATE while it waits for the seat rows a hold has
     * locked; the hold then inserts a booking whose FK takes FOR KEY SHARE on the same showtime.
     * Those two modes do not conflict, so there is no cycle. FOR UPDATE would conflict: checked
     * too, so the test proves it can tell the difference.
     */
    async function insertWhileShowtimeLocked(mode: 'FOR NO KEY UPDATE' | 'FOR UPDATE') {
      const { showtime: st } = await scene();
      const user = await newUser();
      const locker = new Client({ connectionString: db.url });
      const inserter = new Client({ connectionString: db.url });
      await Promise.all([locker.connect(), inserter.connect()]);
      try {
        await locker.query('BEGIN');
        await locker.query(`SELECT id FROM showtimes WHERE id = $1 ${mode}`, [st.id]);
        await inserter.query('BEGIN');
        await inserter.query(`SET LOCAL lock_timeout = '1s'`);
        return await inserter
          .query(
            `INSERT INTO bookings (id, code, user_id, showtime_id, status, subtotal, total,
                                   expires_at, hold_until, idempotency_key, request_hash)
             VALUES ($1, $2, $3, $4, 'PENDING', 0, 0, $5, $5, $6, 'hash')`,
            [
              randomUUID(),
              `LOCK${randomUUID().slice(0, 6)}`,
              user.id,
              st.id,
              instant(plusMinutes(NOW, 15)),
              randomUUID(),
            ],
          )
          .then(
            (result) => ({ inserted: result.rowCount, error: undefined }),
            (error: { code?: string }) => ({ inserted: 0, error: error.code }),
          );
      } finally {
        await inserter.query('ROLLBACK').catch(() => undefined);
        await locker.query('ROLLBACK');
        await Promise.all([locker.end(), inserter.end()]);
      }
    }

    it('FOR NO KEY UPDATE on the showtime does not block a booking insert (FK → FOR KEY SHARE)', async () => {
      expect(await insertWhileShowtimeLocked('FOR NO KEY UPDATE')).toEqual({
        inserted: 1,
        error: undefined,
      });
    });

    it('control: FOR UPDATE on the showtime does block it (lock_timeout → 55P03)', async () => {
      expect(await insertWhileShowtimeLocked('FOR UPDATE')).toEqual({
        inserted: 0,
        error: '55P03',
      });
    });
  });

  // ─── Concurrency ───

  describe('concurrency', () => {
    const deadlocks = async () => {
      const [row] = await db.prisma.$queryRaw<{ deadlocks: number }[]>`
        SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()`;
      return row?.deadlocks ?? 0;
    };

    it('500 users hold the same seat at once: exactly one 201, 499 × 409, no 5xx', async () => {
      const { seat, showtime: st } = await scene();
      const COUNT = 500;
      const emails = Array.from({ length: COUNT }, () => `crowd-${randomUUID()}@test.local`);
      await db.prisma.user.createMany({
        data: emails.map((email) => ({ email, passwordHash: 'x', fullName: 'Crowd' })),
      });
      const users = (
        await db.prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
      ).map((user) => ({ id: user.id, token: tokenOf(user.id) }));
      expect(users).toHaveLength(COUNT);

      // All 500 are sent at once. Windows caps a listening socket's backlog near 200, so the
      // client keeps at most 200 connections open and queues the rest; the API's pool
      // (POOL_MAX = 40) is the real bottleneck either way.
      const crowd = new Agent({ keepAlive: true, maxSockets: 200 });
      const responses = await Promise.all(
        users.map((user) =>
          hold(user, { showtimeId: st.id, seatIds: [seat('A3')] }, randomUUID(), crowd),
        ),
      ).finally(() => crowd.destroy());

      const tally = new Map<string, number>();
      for (const res of responses) {
        const key = res.status === 201 ? '201' : `${res.status} ${errorOf(res).code}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      console.info(`[2.5] 500 holds of one seat: ${JSON.stringify(Object.fromEntries(tally))}`);
      expect(responses.filter((res) => res.status >= 500)).toHaveLength(0);
      expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
      expect(responses.filter((res) => res.status === 409)).toHaveLength(COUNT - 1);
      for (const res of responses.filter((r) => r.status === 409)) {
        expect(['SEAT_LOCKED', 'SEAT_UNAVAILABLE']).toContain(errorOf(res).code);
      }

      const winner = bodyOf<Booking>(responses.find((res) => res.status === 201)!);
      expect(await seatRow(st.id, seat('A3'))).toMatchObject({
        status: 'HELD',
        bookingId: winner.id,
      });
      expect(await bookingCount(st.id)).toBe(1);
      expect(await db.prisma.bookingSeat.count({ where: { seatId: seat('A3') } })).toBe(1);
    }, 60_000);

    it('10 requests with the same key at once: one booking, every answer carries its id, no 5xx', async () => {
      const { seat, showtime: st } = await scene();
      const user = await newUser();
      const key = randomUUID();
      const body = { showtimeId: st.id, seatIds: [seat('B3'), seat('B4')] };

      const responses = await Promise.all(Array.from({ length: 10 }, () => hold(user, body, key)));

      const statuses = responses.map((res) => res.status).sort();
      console.info(`[2.5] 10 same-key holds: statuses ${JSON.stringify(statuses)}`);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
      const ids = new Set(responses.map((res) => bodyOf<Booking>(res).id));
      expect(ids.size).toBe(1);
      expect(await bookingCount(st.id)).toBe(1);
      const rows = await seatRows(st.id);
      expect(rows.filter((row) => row.status === 'HELD').map((row) => row.bookingId)).toEqual([
        ...ids,
        ...ids,
      ]);
    });

    it('cancel racing a hold, 20 rounds: no deadlock, no 5xx, never a hold on a cancelled showtime', async () => {
      const next = random(20_261_107);
      const { room: r, seat } = await room();
      // 20 upcoming showtimes in the same room, 2 h apart (115 min each), created up front.
      const showtimes: CreatedShowtime[] = [];
      for (let i = 0; i < 20; i++) {
        const startsAt = plusMinutes(vn('2026-11-02', '08:00'), 120 * i);
        const res = await admin('post', '/admin/showtimes', {
          movieId: await film(),
          roomId: r.id,
          startsAt,
        });
        expect(res.status).toBe(201);
        showtimes.push(bodyOf<CreatedShowtime>(res));
      }
      const deadlocksBefore = await deadlocks();
      const outcomes = new Map<string, number>();

      for (const st of showtimes) {
        const user = await newUser();
        const seatIds = [seat('A1'), seat('A2'), seat('B3'), seat('B4')];
        // The hold needs a few more round trips than the cancel before it reaches the seat locks,
        // so started together the cancel nearly always wins. Half the rounds start both at once,
        // the other half give the hold a seeded random head start of up to 15 ms.
        const cancelDelay = next() < 0.5 ? 0 : Math.floor(next() * 15);
        const work = [
          () => hold(user, { showtimeId: st.id, seatIds }).then((res) => ({ kind: 'hold', res })),
          () =>
            pause(cancelDelay)
              .then(() => admin('post', `/admin/showtimes/${st.id}/cancel`))
              .then((res) => ({ kind: 'cancel', res })),
        ];

        const [a, b] = await Promise.all(work.map((start) => start()));
        const held = [a, b].find((x) => x!.kind === 'hold')!.res;
        const cancelled = [a, b].find((x) => x!.kind === 'cancel')!.res;
        const label = `hold ${held.status}${held.status === 201 ? '' : ` ${errorOf(held).code}`} / cancel ${cancelled.status}${cancelled.status === 200 ? '' : ` ${errorOf(cancelled).code}`}`;
        outcomes.set(label, (outcomes.get(label) ?? 0) + 1);

        expect(held.status).toBeLessThan(500);
        expect(cancelled.status).toBeLessThan(500);
        // Exactly one of them wins.
        expect([held.status === 201, cancelled.status === 200].filter(Boolean)).toHaveLength(1);

        const status = (await db.prisma.showtime.findUniqueOrThrow({ where: { id: st.id } }))
          .status;
        const rows = await seatRows(st.id);
        if (held.status === 201) {
          const booking = bodyOf<Booking>(held);
          expect(status).toBe('SCHEDULED');
          expect(cancelled.status).toBe(409);
          expect(errorOf(cancelled).code).toBe('SHOWTIME_HAS_BOOKINGS');
          expect(rows.filter((row) => row.status === 'HELD')).toHaveLength(4);
          expect(rows.every((row) => row.status !== 'HELD' || row.bookingId === booking.id)).toBe(
            true,
          );
        } else {
          expect(['SEAT_LOCKED', 'SHOWTIME_CANCELLED']).toContain(errorOf(held).code);
          expect(status).toBe('CANCELLED');
          expect(rows.filter((row) => row.status !== 'AVAILABLE')).toEqual([]);
          expect(await bookingCount(st.id)).toBe(0);
        }
      }

      // Backends report their statistics with a delay; give them a moment before reading.
      await pause(1_500);
      const deadlocksAfter = await deadlocks();
      console.info(
        `[2.5] cancel vs hold, 20 rounds: ${JSON.stringify(Object.fromEntries(outcomes))}; ` +
          `deadlocks ${deadlocksAfter - deadlocksBefore}`,
      );
      expect(deadlocksAfter - deadlocksBefore).toBe(0);
    }, 60_000);
  });
});
