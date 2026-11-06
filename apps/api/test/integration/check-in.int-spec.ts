import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type CheckInResponse, CheckInResult, Role } from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { ticketToken } from '../../src/modules/tickets/ticket-token';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createFixtures, type Fixtures } from '../support/fixtures';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

const NOW = '2026-11-05T12:20:00.000Z';
const QR_SECRET = 'integration-test-ticket-qr-secret-0123456789';
const UNKNOWN_SHOWTIME = '01a3a1aa-0000-7000-8000-000000000000';

describe('Check-in — POST /tickets/check-in (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let fixtures: Fixtures;
  let staffToken: string;
  let staffId: string;
  let adminToken: string;
  let userToken: string;
  const clock = new FakeClock(NOW);

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    fixtures = createFixtures(db.prisma);

    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();

    staffToken = await accessTokenFor(app, db.prisma, Role.STAFF);
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
    staffId = (await db.prisma.user.findFirstOrThrow({ where: { role: Role.STAFF } })).id;
    const user = await fixtures.user();
    userToken = app.get(AccessTokenIssuer).issue({ id: user.id, role: Role.USER }).token;
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => clock.set(NOW));

  // ─── Helpers ───

  const scan = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/tickets/check-in')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** A CONFIRMED booking with one ticket per seat, ready to be checked in. */
  async function sold(seatCount = 2, status: 'ISSUED' | 'VOID' = 'ISSUED') {
    const [user, movie, room] = await Promise.all([
      fixtures.user(),
      fixtures.movie(),
      fixtures.room(),
    ]);
    const seats = await Promise.all(
      Array.from({ length: seatCount }, (_, index) => fixtures.seat(room.id, index + 1)),
    );
    const showtime = await fixtures.showtime({
      movieId: movie.id,
      roomId: room.id,
      startsAt: '2026-11-05T12:30:00.000Z',
      endsAt: '2026-11-05T14:30:00.000Z',
    });
    const booking = await db.prisma.booking.create({
      data: {
        code: `BK${randomUUID().slice(0, 8).toUpperCase()}`,
        userId: user.id,
        showtimeId: showtime.id,
        status: 'CONFIRMED',
        subtotal: 90_000 * seatCount,
        total: 90_000 * seatCount,
        expiresAt: new Date('2026-11-05T09:50:00.000Z'),
        holdUntil: new Date('2026-11-05T09:55:00.000Z'),
        confirmedAt: clock.now(),
        idempotencyKey: randomUUID(),
        requestHash: 'hash',
      },
    });
    const tickets = [];
    for (const seat of seats) {
      await db.prisma.showtimeSeat.create({
        data: {
          showtimeId: showtime.id,
          seatId: seat.id,
          status: 'SOLD',
          bookingId: booking.id,
          price: 90_000,
        },
      });
      await db.prisma.bookingSeat.create({
        data: { bookingId: booking.id, showtimeId: showtime.id, seatId: seat.id, price: 90_000 },
      });
      tickets.push(
        await db.prisma.ticket.create({
          data: {
            bookingId: booking.id,
            showtimeId: showtime.id,
            seatId: seat.id,
            code: randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
            status,
          },
        }),
      );
    }
    return { booking, showtime, seats, tickets, movie, room };
  }

  const stored = (code: string) =>
    db.prisma.ticket.findFirstOrThrow({
      where: { code },
      select: { status: true, checkedInAt: true, checkedInById: true },
    });

  // ─── Tests ───

  it('a scanned QR token lets the holder in, and records who scanned it', async () => {
    const scene = await sold(1);
    const ticket = scene.tickets[0]!;

    const res = await scan(staffToken, {
      token: ticketToken(ticket.code, QR_SECRET),
      showtimeId: scene.showtime.id,
    });

    expect(res.status).toBe(200);
    expect(bodyOf<CheckInResponse>(res)).toEqual({
      result: CheckInResult.OK,
      ticket: {
        code: ticket.code,
        seatLabel: 'A1',
        status: 'CHECKED_IN',
        movieTitle: scene.movie.title,
        roomName: scene.room.name,
        showtimeStartsAt: '2026-11-05T12:30:00.000Z',
        showtimeId: scene.showtime.id,
        bookingCode: scene.booking.code,
        checkedInAt: NOW,
      },
    });
    expect(await stored(ticket.code)).toEqual({
      status: 'CHECKED_IN',
      checkedInAt: new Date(NOW),
      checkedInById: staffId,
    });
  });

  it('a code typed by hand works too, in any case and with stray spaces', async () => {
    const scene = await sold(1);
    const ticket = scene.tickets[0]!;

    const res = await scan(staffToken, { code: `  ${ticket.code.toLowerCase()} ` });

    expect(bodyOf<CheckInResponse>(res).result).toBe(CheckInResult.OK);
    expect((await stored(ticket.code)).status).toBe('CHECKED_IN');
  });

  it('the same ticket twice: the second time says ALREADY_USED and keeps the first time', async () => {
    const scene = await sold(1);
    const ticket = scene.tickets[0]!;
    await scan(staffToken, { code: ticket.code });
    clock.advance({ minutes: 3 });

    const res = await scan(staffToken, { code: ticket.code });

    const body = bodyOf<CheckInResponse>(res);
    expect(body.result).toBe(CheckInResult.ALREADY_USED);
    expect(body.ticket?.checkedInAt).toBe(NOW);
    expect(await stored(ticket.code)).toMatchObject({ checkedInAt: new Date(NOW) });
  });

  it('two doors scanning at the same moment: exactly one OK, no error', async () => {
    const scene = await sold(1);
    const ticket = scene.tickets[0]!;

    const results = await Promise.all(
      Array.from({ length: 6 }, () => scan(staffToken, { code: ticket.code })),
    );

    const verdicts = results.map((res) => {
      expect(res.status).toBe(200);
      return bodyOf<CheckInResponse>(res).result;
    });
    expect(verdicts.filter((result) => result === CheckInResult.OK)).toHaveLength(1);
    expect(verdicts.filter((result) => result === CheckInResult.ALREADY_USED)).toHaveLength(5);
  });

  it('a ticket shown at the wrong door is reported and left untouched', async () => {
    const scene = await sold(1);
    const ticket = scene.tickets[0]!;
    const other = await sold(1);

    const res = await scan(staffToken, {
      code: ticket.code,
      showtimeId: other.showtime.id,
    });

    const body = bodyOf<CheckInResponse>(res);
    expect(body.result).toBe(CheckInResult.WRONG_SHOWTIME);
    expect(body.ticket?.showtimeId).toBe(scene.showtime.id);
    // Still usable at its own door.
    expect(await stored(ticket.code)).toMatchObject({ status: 'ISSUED', checkedInAt: null });
    expect(
      bodyOf<CheckInResponse>(
        await scan(staffToken, { code: ticket.code, showtimeId: scene.showtime.id }),
      ).result,
    ).toBe(CheckInResult.OK);
  });

  it('without showtimeId any showtime is accepted', async () => {
    const scene = await sold(1);

    const res = await scan(staffToken, { code: scene.tickets[0]!.code });

    expect(bodyOf<CheckInResponse>(res).result).toBe(CheckInResult.OK);
  });

  it('a VOID ticket is refused and stays VOID', async () => {
    const scene = await sold(1, 'VOID');
    const ticket = scene.tickets[0]!;

    const res = await scan(staffToken, { code: ticket.code });

    expect(bodyOf<CheckInResponse>(res).result).toBe(CheckInResult.VOID);
    expect(await stored(ticket.code)).toMatchObject({ status: 'VOID', checkedInAt: null });
  });

  it.each([
    ['an unknown code', { code: 'NOSUCHCODE12' }],
    [
      'a token whose signature does not check out',
      { token: 'NOSUCHCODE12.AAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    ],
    [
      'a token signed with another secret',
      { token: ticketToken('NOSUCHCODE12', 'some-other-secret-0123456789abcdef') },
    ],
  ])('%s is NOT_FOUND, with no ticket to show', async (_label, body) => {
    const res = await scan(staffToken, body);

    expect(res.status).toBe(200);
    expect(bodyOf<CheckInResponse>(res)).toEqual({ result: CheckInResult.NOT_FOUND });
  });

  it('a real code with a forged signature is NOT_FOUND, and the ticket is untouched', async () => {
    const scene = await sold(1);
    const ticket = scene.tickets[0]!;

    const res = await scan(staffToken, {
      token: `${ticket.code}.${'A'.repeat(27)}`,
    });

    expect(bodyOf<CheckInResponse>(res).result).toBe(CheckInResult.NOT_FOUND);
    expect(await stored(ticket.code)).toMatchObject({ status: 'ISSUED' });
  });

  it('an admin may scan as well', async () => {
    const scene = await sold(1);

    const res = await scan(adminToken, { code: scene.tickets[0]!.code });

    expect(bodyOf<CheckInResponse>(res).result).toBe(CheckInResult.OK);
  });

  it('403 for a plain user, and the ticket is untouched', async () => {
    const scene = await sold(1);
    const ticket = scene.tickets[0]!;

    const res = await scan(userToken, { code: ticket.code });

    expect(res.status).toBe(403);
    expect(await stored(ticket.code)).toMatchObject({ status: 'ISSUED' });
  });

  it('401 without a token', async () => {
    expect(
      (await request(app.getHttpServer()).post('/tickets/check-in').send({ code: 'X' })).status,
    ).toBe(401);
  });

  it.each([
    ['neither token nor code', {}],
    ['both at once', { token: 'A.B', code: 'ABC' }],
    ['a showtimeId that is not a UUID', { code: 'ABC', showtimeId: 'nope' }],
    ['an unknown showtime is still a valid request', { code: 'ABC', showtimeId: UNKNOWN_SHOWTIME }],
  ])('%s', async (label, body) => {
    const res = await scan(staffToken, body);

    if (label === 'an unknown showtime is still a valid request') {
      expect(res.status).toBe(200);
      expect(bodyOf<CheckInResponse>(res).result).toBe(CheckInResult.NOT_FOUND);
      return;
    }
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
  });
});
