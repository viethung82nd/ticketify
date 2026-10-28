import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type AdminRoom,
  AuthErrorCode,
  type Booking,
  type ClientToServerEvents,
  type CreatedShowtime,
  DayType,
  type HandshakeErrorData,
  type JoinShowtimeAck,
  REALTIME_LIMITS,
  RealtimeErrorCode,
  type RealtimeError,
  Role,
  SeatType,
  type ServerToClientEvents,
} from '@ticketify/shared';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../src/modules/bookings/booking-expiry.service';
import { BookingService } from '../../src/modules/bookings/booking.service';
import { EmitterSeatEvents } from '../../src/modules/realtime/emitter-seat-events';
import {
  type RealtimeIoAdapter,
  setupRealtime,
} from '../../src/modules/realtime/realtime-io.adapter';
import { REALTIME_CHANNEL_KEY } from '../../src/modules/realtime/realtime-redis';
import { SeatEvents } from '../../src/modules/realtime/seat-events';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';
import { captureServerErrors } from '../support/server-errors';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
const HOLD_MINUTES = (HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS) / 60;
const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';
/** Longest a test waits for an event that must arrive (real time, Redis round trip). */
const EVENT_TIMEOUT_MS = 5_000;

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` (real time) until it returns true; fails after EVENT_TIMEOUT_MS. */
async function eventually(check: () => boolean): Promise<void> {
  for (let waited = 0; waited < EVENT_TIMEOUT_MS; waited += 20) {
    if (check()) return;
    await pause(20);
  }
  throw new Error(`Condition not met within ${EVENT_TIMEOUT_MS}ms`);
}

/** `true` once a `warn` line mentioning best-effort delivery was logged. */
const warnedBestEffort = (warn: jest.SpyInstance) => () =>
  warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('best-effort'));

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type SeatEventName = 'seat:held' | 'seat:released' | 'seat:sold';

interface Received {
  event: SeatEventName;
  payload: { showtimeId: string; seatIds: string[]; heldUntil?: string };
}

/** Every seat event one socket received, in order. */
function recorder(socket: ClientSocket) {
  const events: Received[] = [];
  for (const event of ['seat:held', 'seat:released', 'seat:sold'] as const) {
    socket.on(event, (payload: Received['payload']) => events.push({ event, payload }));
  }
  return {
    events,
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
  token: string;
}

describe('Realtime — gateway, rooms, seat events, multi-instance (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  /** Two API instances on the same Postgres and Redis (like two containers behind Caddy). */
  let appA: INestApplication<App>;
  let appB: INestApplication<App>;
  let adapterB: RealtimeIoAdapter;
  let urlA: string;
  let urlB: string;
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let adminToken: string;
  const clock = new FakeClock(NOW);
  /** Own channel prefix: Redis pub/sub ignores the logical database the suites are split into. */
  const channelKey = `ticketify-test:${randomUUID()}`;
  const sockets: ClientSocket[] = [];

  async function apiInstance(): Promise<{
    app: INestApplication<App>;
    adapter: RealtimeIoAdapter;
  }> {
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    const adapter = await setupRealtime(app);
    await app.listen(0, '127.0.0.1');
    return { app, adapter };
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
        },
      ),
    );
    ({ app: appA } = await apiInstance());
    ({ app: appB, adapter: adapterB } = await apiInstance());
    urlA = await appA.getUrl();
    urlB = await appB.getUrl();
    adminToken = await accessTokenFor(appA, db.prisma, Role.ADMIN);
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
    await appA?.close();
    await appB?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => clock.set(NOW));

  afterEach(() => {
    jest.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  // ─── Helpers ───

  const tokenOf = (id: string) => appA.get(AccessTokenIssuer).issue({ id, role: Role.USER }).token;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `realtime-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Realtime User ${userCounter}`,
      },
    });
    return { id: user.id, token: tokenOf(user.id) };
  }

  function socketTo(url: string, auth: object, extraHeaders?: Record<string, string>) {
    const socket: ClientSocket = io(url, {
      transports: ['websocket'],
      auth,
      extraHeaders,
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  /** A connected socket of a new user, on instance `url`. */
  async function connect(url = urlA): Promise<ClientSocket> {
    const socket = socketTo(url, { token: (await newUser()).token });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }

  /** The `connect_error` a refused handshake ends with. */
  function refusal(socket: ClientSocket): Promise<Error & { data?: HandshakeErrorData }> {
    return new Promise((resolve, reject) => {
      socket.once('connect', () => reject(new Error('Connected, expected a refusal')));
      socket.once('connect_error', resolve);
    });
  }

  const join = (socket: ClientSocket, showtimeId: string): Promise<JoinShowtimeAck> =>
    socket.timeout(EVENT_TIMEOUT_MS).emitWithAck('showtime:join', { showtimeId });

  const http = (app: INestApplication<App> = appA) => request(app.getHttpServer());

  const hold = (
    user: TestUser,
    showtimeId: string,
    seatIds: string[],
    app: INestApplication<App> = appA,
  ) =>
    http(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });

  async function held(
    showtimeId: string,
    seatIds: string[],
    app: INestApplication<App> = appA,
  ): Promise<Booking> {
    const res = await hold(await newUser(), showtimeId, seatIds, app);
    expect(res.status).toBe(201);
    return bodyOf<Booking>(res);
  }

  const admin = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', `Bearer ${adminToken}`).send(body);

  let movieId: string | undefined;
  let counter = 0;
  /** Fresh 2×5 room with one upcoming showtime; `seat('A1')` gives a seat id. */
  async function scene() {
    counter += 1;
    const roomRes = await admin('/admin/rooms', { name: `Phòng RT ${counter}`, rows: 2, cols: 5 });
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
          title: 'Realtime Movie',
          slug: `realtime-movie-${randomUUID()}`,
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

  // ─── Handshake ───

  describe('handshake (JWT in auth.token)', () => {
    it('a valid access token connects', async () => {
      const socket = await connect();

      expect(socket.connected).toBe(true);
    });

    it('no token → refused with UNAUTHORIZED', async () => {
      const error = await refusal(socketTo(urlA, {}));

      expect(error.message).toBe(AuthErrorCode.UNAUTHORIZED);
      expect(error.data?.code).toBe(AuthErrorCode.UNAUTHORIZED);
    });

    it('an expired token → refused with TOKEN_EXPIRED', async () => {
      const { token } = await newUser();
      clock.advance({ hours: 1 });

      const error = await refusal(socketTo(urlA, { token }));

      expect(error.message).toBe(AuthErrorCode.TOKEN_EXPIRED);
      expect(error.data?.code).toBe(AuthErrorCode.TOKEN_EXPIRED);
      expect(error.data?.message).toBe('Access token expired');
    });

    it('a forged token → refused with TOKEN_INVALID', async () => {
      const { token } = await newUser();

      const error = await refusal(socketTo(urlA, { token: `${token.slice(0, -4)}AAAA` }));

      expect(error.message).toBe(AuthErrorCode.TOKEN_INVALID);
    });

    it('a browser Origin outside CORS_ORIGINS is refused before the handshake', async () => {
      const { token } = await newUser();

      const error = await refusal(socketTo(urlA, { token }, { origin: 'https://evil.example' }));

      expect(error.message).toMatch(/websocket error/i);
    });

    it('an Origin listed in CORS_ORIGINS connects', async () => {
      const { token } = await newUser();
      const socket = socketTo(urlA, { token }, { origin: 'http://localhost:5173' });

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
    });
  });

  // ─── Rooms ───

  describe('showtime:join / showtime:leave', () => {
    /** Ack of a failed join, and the `error` event that came with it. */
    async function failedJoin(socket: ClientSocket, showtimeId: string) {
      const errorEvent = new Promise<RealtimeError>((resolve) => socket.once('error', resolve));
      const ack = await join(socket, showtimeId);
      return { ack, errorEvent: await errorEvent };
    }

    it('joins a scheduled showtime: ack { joined: true }', async () => {
      const { showtime } = await scene();

      await expect(join(await connect(), showtime.id)).resolves.toEqual({ joined: true });
    });

    it('an unknown showtime → SHOWTIME_NOT_FOUND (ack and error event)', async () => {
      const { ack, errorEvent } = await failedJoin(await connect(), UNKNOWN_ID);

      expect(ack).toEqual({ joined: false, error: errorEvent });
      expect(errorEvent).toMatchObject({ event: 'showtime:join', code: 'SHOWTIME_NOT_FOUND' });
    });

    it('a cancelled showtime → SHOWTIME_NOT_FOUND, not joined', async () => {
      const { showtime } = await scene();
      expect((await admin(`/admin/showtimes/${showtime.id}/cancel`)).status).toBe(200);

      const { ack } = await failedJoin(await connect(), showtime.id);

      expect(ack).toMatchObject({ joined: false, error: { code: 'SHOWTIME_NOT_FOUND' } });
    });

    it('a malformed id → VALIDATION_FAILED', async () => {
      const { ack } = await failedJoin(await connect(), 'not-a-uuid');

      expect(ack).toMatchObject({ joined: false, error: { code: 'VALIDATION_FAILED' } });
    });

    it(`at most ${REALTIME_LIMITS.subscriptionsMax} showtimes per socket → TOO_MANY_SUBSCRIPTIONS`, async () => {
      const socket = await connect();
      const showtimes = [];
      for (let i = 0; i <= REALTIME_LIMITS.subscriptionsMax; i++) {
        showtimes.push((await scene()).showtime.id);
      }
      for (const id of showtimes.slice(0, -1)) {
        await expect(join(socket, id)).resolves.toEqual({ joined: true });
      }

      const { ack } = await failedJoin(socket, showtimes.at(-1)!);

      expect(ack).toMatchObject({
        joined: false,
        error: { code: RealtimeErrorCode.TOO_MANY_SUBSCRIPTIONS },
      });
      // Leaving one frees a slot.
      await expect(
        socket
          .timeout(EVENT_TIMEOUT_MS)
          .emitWithAck('showtime:leave', { showtimeId: showtimes[0]! }),
      ).resolves.toEqual({ left: true });
      await expect(join(socket, showtimes.at(-1)!)).resolves.toEqual({ joined: true });
    });

    it(`more than ${REALTIME_LIMITS.joinsMax} joins a minute → TOO_MANY_ATTEMPTS, not TOO_MANY_SUBSCRIPTIONS`, async () => {
      const { showtime } = await scene();
      const socket = await connect();
      // Joining the same room again is not a new subscription, but it is a new attempt.
      for (let i = 0; i < REALTIME_LIMITS.joinsMax; i++) {
        await expect(join(socket, showtime.id)).resolves.toEqual({ joined: true });
      }

      const { ack, errorEvent } = await failedJoin(socket, showtime.id);

      expect(ack).toEqual({ joined: false, error: errorEvent });
      expect(errorEvent).toMatchObject({
        event: 'showtime:join',
        code: RealtimeErrorCode.TOO_MANY_ATTEMPTS,
        details: { retryAfterSeconds: expect.any(Number) as number },
      });
      expect(errorEvent.code).not.toBe(RealtimeErrorCode.TOO_MANY_SUBSCRIPTIONS);
    });

    it('after leaving, the socket no longer receives the showtime events', async () => {
      const { showtime, seat } = await scene();
      const socket = await connect();
      const received = recorder(socket);
      await join(socket, showtime.id);
      await socket
        .timeout(EVENT_TIMEOUT_MS)
        .emitWithAck('showtime:leave', { showtimeId: showtime.id });
      // Barrier: a second socket still in the room sees the event, so it was sent.
      const witness = await connect();
      const seen = recorder(witness);
      await join(witness, showtime.id);

      await held(showtime.id, [seat('A1')]);
      await seen.waitFor(1);

      expect(received.events).toEqual([]);
    });
  });

  // ─── seat:held (API) ───

  describe('seat:held after POST /bookings commits', () => {
    it('a joined client receives the seats and heldUntil; a client in another room does not', async () => {
      const first = await scene();
      const other = await scene();
      const watcher = await connect();
      const outsider = await connect();
      const watched = recorder(watcher);
      const outside = recorder(outsider);
      await join(watcher, first.showtime.id);
      await join(outsider, other.showtime.id);
      const notJoined = recorder(await connect());

      const booking = await held(first.showtime.id, [first.seat('B5'), first.seat('A1')]);
      // Barrier for the outsider: an event of its own room, sent after the first one.
      await held(other.showtime.id, [other.seat('A1')]);
      await outside.waitFor(1);

      expect(await watched.waitFor(1)).toEqual([
        {
          event: 'seat:held',
          payload: {
            showtimeId: first.showtime.id,
            seatIds: [first.seat('A1'), first.seat('B5')].sort(),
            heldUntil: booking.holdUntil,
          },
        },
      ]);
      // Never the user, the booking or the whole map.
      expect(Object.keys(watched.events[0]!.payload).sort()).toEqual([
        'heldUntil',
        'seatIds',
        'showtimeId',
      ]);
      expect(outside.events.map((e) => e.payload.showtimeId)).toEqual([other.showtime.id]);
      expect(notJoined.events).toEqual([]);
    });

    it('a 409 (seat already held) sends nothing', async () => {
      const { showtime, seat } = await scene();
      const socket = await connect();
      const received = recorder(socket);
      await join(socket, showtime.id);
      await held(showtime.id, [seat('A1')]);
      await received.waitFor(1);

      const conflict = await hold(await newUser(), showtime.id, [seat('A1'), seat('A2')]);
      expect(conflict.status).toBe(409);
      expect(errorOf(conflict).code).toBe('SEAT_UNAVAILABLE');
      await held(showtime.id, [seat('A3')]); // barrier

      const events = await received.waitFor(2);
      expect(events.map((e) => e.payload.seatIds)).toEqual([[seat('A1')], [seat('A3')]]);
    });

    it('an idempotent replay (same key, 200) sends nothing: no seat changed', async () => {
      const { showtime, seat } = await scene();
      const socket = await connect();
      const received = recorder(socket);
      await join(socket, showtime.id);
      const user = await newUser();
      const key = randomUUID();
      const send = () =>
        http()
          .post('/bookings')
          .set('Authorization', `Bearer ${user.token}`)
          .set('Idempotency-Key', key)
          .send({ showtimeId: showtime.id, seatIds: [seat('A1')] });
      expect((await send()).status).toBe(201);
      expect((await send()).status).toBe(200);
      await held(showtime.id, [seat('A2')]); // barrier

      const events = await received.waitFor(2);
      expect(events.map((e) => e.payload.seatIds)).toEqual([[seat('A1')], [seat('A2')]]);
    });

    it('a transaction rolled back after the seats were updated sends nothing', async () => {
      const { showtime, seat } = await scene();
      const socket = await connect();
      const received = recorder(socket);
      await join(socket, showtime.id);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const errors = captureServerErrors();
      // Fail inside the transaction AFTER every write of the hold (seats already HELD in it).
      const bookingService = appA.get(BookingService);
      const service = bookingService as unknown as {
        holdInTransaction: (...args: unknown[]) => Promise<unknown>;
      };
      const original = service.holdInTransaction.bind(service);
      const spy = jest
        .spyOn(service, 'holdInTransaction')
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new Error('injected failure before commit');
        });

      const res = await hold(await newUser(), showtime.id, [seat('A1')]);
      errors.restore();
      spy.mockRestore();

      expect(res.status).toBe(500);
      expect(errors.errors.map((e) => e.message)).toEqual(['injected failure before commit']);
      expect(await db.prisma.booking.count({ where: { showtimeId: showtime.id } })).toBe(0);
      expect(
        await db.prisma.showtimeSeat.findUniqueOrThrow({
          where: { showtimeId_seatId: { showtimeId: showtime.id, seatId: seat('A1') } },
          select: { status: true },
        }),
      ).toEqual({ status: 'AVAILABLE' });
      await held(showtime.id, [seat('A2')]); // barrier

      const events = await received.waitFor(1);
      expect(events.map((e) => e.payload.seatIds)).toEqual([[seat('A2')]]);
    });
  });

  // ─── seat:released (worker, Redis emitter) ───

  describe('seat:released after expireBooking commits (worker)', () => {
    it('expired → released seats reach clients on BOTH instances; noop/early/skipped send nothing', async () => {
      const { showtime, seat } = await scene();
      const onA = await connect(urlA);
      const onB = await connect(urlB);
      const receivedA = recorder(onA);
      const receivedB = recorder(onB);
      await join(onA, showtime.id);
      await join(onB, showtime.id);

      const first = await held(showtime.id, [seat('A1'), seat('A2')]);
      clock.advance({ minutes: 5 });
      const later = await held(showtime.id, [seat('B1')]);
      const locked = await held(showtime.id, [seat('B2')]);
      await receivedA.waitFor(3);
      await receivedB.waitFor(3);

      // early: `later` has 5 minutes left.
      clock.advance({ minutes: HOLD_MINUTES - 5 });
      await expect(expiry.expire(later.id)).resolves.toEqual({
        outcome: 'early',
        holdUntil: instant(later.holdUntil),
      });
      // skipped: another transaction holds the booking row.
      const pg = new Client({ connectionString: db.url });
      await pg.connect();
      try {
        await pg.query('BEGIN');
        await pg.query('SELECT 1 FROM bookings WHERE id = $1 FOR UPDATE', [locked.id]);
        clock.advance({ minutes: 5 });
        await expect(expiry.expire(locked.id)).resolves.toEqual({ outcome: 'skipped' });
        await pg.query('ROLLBACK');
      } finally {
        await pg.end();
      }
      // expired, then noop for the second run.
      await expect(expiry.expire(first.id)).resolves.toEqual({
        outcome: 'expired',
        showtimeId: showtime.id,
        releasedSeatIds: [seat('A1'), seat('A2')].sort(),
      });
      await expect(expiry.expire(first.id)).resolves.toEqual({ outcome: 'noop' });
      // Barrier: one more expiry that does release seats.
      await expect(expiry.expire(later.id)).resolves.toMatchObject({ outcome: 'expired' });

      for (const received of [receivedA, receivedB]) {
        const events = await received.waitFor(5);
        expect(events.slice(3)).toEqual([
          {
            event: 'seat:released',
            payload: { showtimeId: showtime.id, seatIds: [seat('A1'), seat('A2')].sort() },
          },
          { event: 'seat:released', payload: { showtimeId: showtime.id, seatIds: [seat('B1')] } },
        ]);
      }
    });

    it('an expired booking whose seats another booking already took sends nothing', async () => {
      const { showtime, seat } = await scene();
      const socket = await connect();
      const received = recorder(socket);
      await join(socket, showtime.id);
      const stale = await held(showtime.id, [seat('A1')]);
      clock.advance({ minutes: HOLD_MINUTES });
      // Lazy expiry: the expired hold is free for the next customer before any job ran.
      await held(showtime.id, [seat('A1')]);
      const barrier = await held(showtime.id, [seat('A2')]);

      await expect(expiry.expire(stale.id)).resolves.toEqual({
        outcome: 'expired',
        showtimeId: showtime.id,
        releasedSeatIds: [],
      });
      clock.advance({ minutes: HOLD_MINUTES });
      await expiry.expire(barrier.id);

      const events = await received.waitFor(4);
      expect(events.map((e) => [e.event, e.payload.seatIds])).toEqual([
        ['seat:held', [seat('A1')]],
        ['seat:held', [seat('A1')]],
        ['seat:held', [seat('A2')]],
        ['seat:released', [seat('A2')]],
      ]);
    });
  });

  // ─── Multi-instance fan-out (Redis adapter) ───

  describe('several API instances', () => {
    it('a client on A receives seat:held for a booking made through B, and vice versa', async () => {
      const { showtime, seat } = await scene();
      const onA = await connect(urlA);
      const onB = await connect(urlB);
      const receivedA = recorder(onA);
      const receivedB = recorder(onB);
      await join(onA, showtime.id);
      await join(onB, showtime.id);

      const throughB = await held(showtime.id, [seat('A1')], appB);
      const throughA = await held(showtime.id, [seat('A2')], appA);

      for (const received of [receivedA, receivedB]) {
        const events = await received.waitFor(2);
        expect(events).toEqual([
          {
            event: 'seat:held',
            payload: {
              showtimeId: showtime.id,
              seatIds: [seat('A1')],
              heldUntil: throughB.holdUntil,
            },
          },
          {
            event: 'seat:held',
            payload: {
              showtimeId: showtime.id,
              seatIds: [seat('A2')],
              heldUntil: throughA.holdUntil,
            },
          },
        ]);
      }
    });
  });

  // ─── Best-effort ───

  describe('best-effort delivery', () => {
    it('Redis publisher down on B: POST /bookings still 201, a warning, B’s own clients still told', async () => {
      const { showtime, seat } = await scene();
      const onA = await connect(urlA);
      const onB = await connect(urlB);
      const receivedA = recorder(onA);
      const receivedB = recorder(onB);
      await join(onA, showtime.id);
      await join(onB, showtime.id);
      const warn = jest.spyOn(Logger.prototype, 'warn');

      adapterB.pubClient.disconnect();
      try {
        const res = await hold(await newUser(), showtime.id, [seat('A1')], appB);

        expect(res.status).toBe(201);
        await receivedB.waitFor(1);
        await eventually(warnedBestEffort(warn));
      } finally {
        await adapterB.pubClient.connect();
      }
      // A missed it; its next reload of the seat map (reconnect, 409) shows the seat held.
      await held(showtime.id, [seat('A2')], appA); // barrier on A
      expect((await receivedA.waitFor(1)).map((e) => e.payload.seatIds)).toEqual([[seat('A2')]]);
    });

    it('worker emitter down: the booking still expires, a warning, nothing thrown', async () => {
      const { showtime, seat } = await scene();
      const booking = await held(showtime.id, [seat('A1')]);
      clock.advance({ minutes: HOLD_MINUTES });
      const emitter = workerRef.get<SeatEvents, EmitterSeatEvents>(SeatEvents);
      const warn = jest.spyOn(Logger.prototype, 'warn');

      emitter.connection.disconnect();
      try {
        await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
        await eventually(warnedBestEffort(warn));
      } finally {
        await emitter.connection.connect();
      }
      expect(
        await db.prisma.booking.findUniqueOrThrow({
          where: { id: booking.id },
          select: { status: true },
        }),
      ).toEqual({ status: 'EXPIRED' });
    });
  });
});
