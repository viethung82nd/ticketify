import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type AdminRoom, DayType, Role, SeatType } from '@ticketify/shared';
import { Client } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { SHOWTIME_TX } from '../../src/modules/showtimes/showtimes.service';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createFixtures, type Fixtures } from '../support/fixtures';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';
import { captureServerErrors, formatServerErrors } from '../support/server-errors';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
/** Two connections for ten requests (production default is 10, ROADMAP 2.1). */
const POOL_MAX = 2;
const REQUESTS = 10;

/**
 * Showtime creates when the API has far fewer connections than concurrent requests. Whatever the
 * timing, each request ends 201, 409 SHOWTIME_OVERLAP or 503 DATABASE_BUSY — never 500.
 */
describe('Showtime creates under connection pressure (pool of 2, real Postgres)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let fixtures: Fixtures;
  let app: INestApplication<App>;
  let adminToken: string;
  const serverErrors = captureServerErrors();

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        { DATABASE_POOL_MAX: String(POOL_MAX), SHOWTIME_CLEANUP_MINUTES: '15' },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(new FakeClock(NOW))
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0, '127.0.0.1');
    fixtures = createFixtures(db.prisma);
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: 90_000 })),
      ),
    });
  });

  afterAll(async () => {
    serverErrors.restore();
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => serverErrors.clear());

  const admin = () => request(app.getHttpServer());

  let roomCounter = 0;
  async function scene() {
    roomCounter += 1;
    const res = await admin()
      .post('/admin/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Phòng Pool ${roomCounter}`, rows: 2, cols: 5 });
    expect(res.status).toBe(201);
    const room = bodyOf<AdminRoom>(res);
    const movie = await fixtures.movie();
    return { room, movie };
  }

  /** Ten creates starting 0–9 minutes apart from 19:00 Monday: every pair overlaps. */
  function overlappingCreates(roomId: string, movieId: string): Promise<Response>[] {
    return Array.from({ length: REQUESTS }, (_, i) =>
      admin()
        .post('/admin/showtimes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          movieId,
          roomId,
          startsAt: new Date(Date.parse('2026-11-02T12:00:00Z') + i * 60_000).toISOString(),
        })
        .then((res) => res),
    );
  }

  /** Status → count, with the error code next to non-201 answers (e.g. `409 SHOWTIME_OVERLAP`). */
  function tally(responses: Response[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const res of responses) {
      const key = res.status === 201 ? '201' : `${res.status} ${errorOf(res).code}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  /** The invariants every round must keep, whatever the distribution. */
  async function expectNo500(roomId: string, responses: Response[]) {
    expect(formatServerErrors(serverErrors.errors.filter((e) => e.statusCode !== 503))).toBe('');
    for (const res of responses) {
      expect([201, 409, 503]).toContain(res.status);
      if (res.status === 409) expect(errorOf(res).code).toBe('SHOWTIME_OVERLAP');
      if (res.status === 503) expect(errorOf(res).code).toBe('DATABASE_BUSY');
    }
    const created = responses.filter((res) => res.status === 201).length;
    expect(created).toBeLessThanOrEqual(1);
    // A 503 never leaves a half-created showtime behind.
    expect(await db.prisma.showtime.count({ where: { roomId } })).toBe(created);
  }

  it('10 overlapping creates, 5 rounds: only 201, 409 SHOWTIME_OVERLAP or 503 DATABASE_BUSY', async () => {
    const rounds: Record<string, number>[] = [];
    for (let round = 0; round < 5; round++) {
      serverErrors.clear();
      const { room, movie } = await scene();
      const responses = await Promise.all(overlappingCreates(room.id, movie.id));
      rounds.push(tally(responses));
      await expectNo500(room.id, responses);
    }
    console.info(`[pool ${POOL_MAX}] 10 overlapping creates × 5 rounds: ${JSON.stringify(rounds)}`);
  });

  it(`pool exhausted longer than maxWait (${SHOWTIME_TX.maxWait} ms): the waiting requests get 503 DATABASE_BUSY, not 500`, async () => {
    const { room, movie } = await scene();
    // Another session holds the room row, so the first two creates take both pool connections
    // and wait on it; the other eight cannot start a transaction within maxWait.
    const blocker = new Client({ connectionString: db.url });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [room.id]);
      const pending = Promise.all(overlappingCreates(room.id, movie.id));
      // Released well inside the transactions' own timeout, after maxWait has passed.
      await new Promise((resolve) => setTimeout(resolve, SHOWTIME_TX.maxWait + 1_000));
      await blocker.query('COMMIT');
      const responses = await pending;

      const counts = tally(responses);
      console.info(`[pool ${POOL_MAX}] exhausted for > maxWait: ${JSON.stringify(counts)}`);
      await expectNo500(room.id, responses);
      expect(counts).toEqual({
        '201': 1,
        '409 SHOWTIME_OVERLAP': POOL_MAX - 1,
        '503 DATABASE_BUSY': REQUESTS - POOL_MAX,
      });
      // Logged like any 5xx, with the Prisma code behind it.
      expect(serverErrors.errors.map((e) => e.prismaCode)).toEqual(
        Array<string>(REQUESTS - POOL_MAX).fill('P2028'),
      );
    } finally {
      await blocker.end();
    }
  });
});
