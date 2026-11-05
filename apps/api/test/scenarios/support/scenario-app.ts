import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { type AdminRoom, type CreatedShowtime, DayType, Role, SeatType } from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../../src/modules/bookings/booking-expiry.service';
import { REALTIME_CHANNEL_KEY } from '../../../src/modules/realtime/realtime-redis';
import { appTestEnv } from '../../support/app-env';
import { userIdWithRole } from '../../support/auth';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { createTestRedis, type TestRedis } from '../../support/redis';
import { captureServerErrors, type ServerError } from '../../support/server-errors';
import { scenariosEnabled } from './enabled';

/** `describe` with RUN_SCENARIO_TESTS=1, `describe.skip` otherwise. */
export const describeScenario = scenariosEnabled ? describe : describe.skip;

/**
 * 17:00 Sunday 2026-11-01 in Vietnam. Scenarios A and B never move the clock; scenario C does,
 * through `ScenarioApp.clock`, to reach the grace period and the expiry.
 */
export const SCENARIO_NOW = '2026-11-01T10:00:00.000Z';
/**
 * The API's pool (`DATABASE_POOL_MAX`) in every scenario: the same 40 as the 500-request test of
 * week 7. Large enough that the pool is not the bottleneck of a 500-request burst.
 */
export const SCENARIO_POOL_MAX = 40;
/** Showtimes are created this far apart in one room (a 100-minute film takes 115 minutes). */
const SHOWTIME_SPACING_MINUTES = 120;
/** First showtime of a scenario: 08:00 Monday 2026-11-02 in Vietnam (WEEKDAY prices). */
const FIRST_SHOWTIME = '2026-11-02T08:00:00+07:00';
const SEAT_PRICE = 90_000;

export interface ScenarioUser {
  id: string;
  token: string;
}

export interface ScenarioRoom {
  id: string;
  /** Seat id of a label such as `A1`. */
  seat(label: string): string;
}

export interface ScenarioOptions {
  /** Extra environment for the app, e.g. the VNPay test merchant settings of scenario C. */
  env?: Record<string, string>;
  /**
   * Also compile the worker module (never started), so a scenario can call its services directly
   * — scenario C races the booking expiry against an IPN.
   */
  worker?: boolean;
}

/** Worker-side services of a scenario, compiled but not started. */
export interface ScenarioWorker {
  expiry: BookingExpiryService;
}

export interface ScenarioApp {
  app: INestApplication<App>;
  db: TestDatabase;
  /** The clock both the app and the worker read. Moving it is how a scenario reaches an expiry. */
  clock: FakeClock;
  /** Present only with `options.worker`. */
  worker: ScenarioWorker | null;
  /** `http://127.0.0.1:<port>` of the API. */
  baseUrl: string;
  /** `application_name` of the API's own Postgres connections (see `samplePool`). */
  applicationName: string;
  /** Every 5xx the API answered, with its Prisma code and SQLSTATE. */
  serverErrors: ServerError[];
  /** `count` new users, with access tokens signed by the app. */
  users(count: number): Promise<ScenarioUser[]>;
  /** A `rows × cols` STANDARD room through the admin API; `couples` are same-row label pairs. */
  room(rows: number, cols: number, couples?: readonly [string, string][]): Promise<ScenarioRoom>;
  /** The next upcoming showtime of `roomId` (one per call, 2 h apart). */
  showtime(roomId: string): Promise<CreatedShowtime>;
  close(): Promise<void>;
}

/**
 * Boots the API like an integration suite does, on its own database and Redis database, with a
 * fixed `FakeClock`, `DATABASE_POOL_MAX` = 40 and the per-user rate limit out of the way (every
 * scenario user sends one request per showtime, but a run creates many showtimes).
 */
export async function bootScenarioApp(
  name: string,
  options: ScenarioOptions = {},
): Promise<ScenarioApp> {
  const [db, redis]: [TestDatabase, TestRedis] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
  ]);
  const applicationName = `ticketify-scenario-${name}`;
  const databaseUrl = new URL(db.url);
  databaseUrl.searchParams.set('application_name', applicationName);
  Object.assign(
    process.env,
    appTestEnv(
      { databaseUrl: databaseUrl.toString(), redisUrl: redis.url },
      {
        DATABASE_POOL_MAX: String(SCENARIO_POOL_MAX),
        BOOKING_RATE_LIMIT_MAX: '100000',
        ...options.env,
      },
    ),
  );
  const clock = new FakeClock(SCENARIO_NOW);
  // Own channel prefix: Redis pub/sub ignores the logical database the suites are split into, so
  // without it one scenario's seat events would reach another's sockets.
  const channelKey = `ticketify-scenario-${name}:${randomUUID()}`;
  const { AppModule } = await import('../../../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ClockService)
    .useValue(clock)
    .overrideProvider(REALTIME_CHANNEL_KEY)
    .useValue(channelKey)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  // Node's default backlog (511) already covers a 500-request burst.
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const server = captureServerErrors();
  const adminId = await userIdWithRole(db.prisma, Role.ADMIN);
  const issuer = app.get(AccessTokenIssuer);
  await db.prisma.seatPrice.createMany({
    data: Object.values(SeatType).flatMap((seatType) =>
      Object.values(DayType).map((dayType) => ({ seatType, dayType, price: SEAT_PRICE })),
    ),
  });
  const movie = await db.prisma.movie.create({
    data: {
      title: `Scenario ${name}`,
      slug: `scenario-${name}-${randomUUID()}`,
      duration: 100,
      ageRating: 'P',
      releaseDate: new FakeClock('2026-10-01').now(),
    },
  });

  // The worker process' own graph, on the same database, Redis and clock. Compiled, never started:
  // the scenario calls its services itself, so a job never fires behind the test's back.
  let workerRef: TestingModule | null = null;
  if (options.worker) {
    const { WorkerModule } = await import('../../../src/worker.module.js');
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
  }

  const admin = (method: 'post' | 'patch', path: string, body: object) =>
    request(app.getHttpServer())
      [method](path)
      // Signed at the clock's current "now": a token lives 15 minutes on that clock, and scenario
      // C moves it past the hold TTL and the grace period between two admin calls.
      .set('Authorization', `Bearer ${issuer.issue({ id: adminId, role: Role.ADMIN }).token}`)
      .send(body);
  const showtimesPerRoom = new Map<string, number>();
  let roomCount = 0;

  return {
    app,
    db,
    clock,
    worker: workerRef ? { expiry: workerRef.get(BookingExpiryService) } : null,
    baseUrl,
    applicationName,
    serverErrors: server.errors,

    async users(count) {
      const emails = Array.from(
        { length: count },
        (_, i) => `scenario-${name}-${i}-${randomUUID()}@test.local`,
      );
      await db.prisma.user.createMany({
        data: emails.map((email) => ({ email, passwordHash: 'x', fullName: `Scenario ${name}` })),
      });
      const rows = await db.prisma.user.findMany({
        where: { email: { in: emails } },
        select: { id: true },
      });
      if (rows.length !== count) throw new Error(`Created ${rows.length} users, wanted ${count}`);
      return rows.map((row) => ({
        id: row.id,
        token: issuer.issue({ id: row.id, role: Role.USER }).token,
      }));
    },

    async room(rows, cols, couples = []) {
      roomCount += 1;
      const created = await admin('post', '/admin/rooms', {
        name: `Phòng Scenario ${name} ${roomCount}`,
        rows,
        cols,
      });
      if (created.status !== 201) throw new Error(`Room: ${created.status} ${created.text}`);
      const body = created.body as AdminRoom;
      const ids = new Map(body.seats.map((s) => [`${s.row}${s.number}`, s.id]));
      const seat = (label: string) => {
        const id = ids.get(label);
        if (!id) throw new Error(`No seat ${label}`);
        return id;
      };
      if (couples.length > 0) {
        const edited = await admin('patch', `/admin/rooms/${body.id}/seats`, {
          changes: couples.flatMap(([a, b]) => [
            { seatId: seat(a), type: SeatType.COUPLE, coupleWith: seat(b) },
            { seatId: seat(b), type: SeatType.COUPLE, coupleWith: seat(a) },
          ]),
        });
        if (edited.status !== 200) throw new Error(`Couples: ${edited.status} ${edited.text}`);
      }
      return { id: body.id, seat };
    },

    async showtime(roomId) {
      const index = showtimesPerRoom.get(roomId) ?? 0;
      showtimesPerRoom.set(roomId, index + 1);
      const startsAt = new FakeClock(FIRST_SHOWTIME);
      startsAt.advance({ minutes: SHOWTIME_SPACING_MINUTES * index });
      const res = await admin('post', '/admin/showtimes', {
        movieId: movie.id,
        roomId,
        startsAt: startsAt.now().toISOString(),
      });
      if (res.status !== 201) throw new Error(`Showtime: ${res.status} ${res.text}`);
      return res.body as CreatedShowtime;
    },

    async close() {
      server.restore();
      await workerRef?.close();
      await app.close();
      await Promise.all([db.drop(), redis.close()]);
    },
  };
}
