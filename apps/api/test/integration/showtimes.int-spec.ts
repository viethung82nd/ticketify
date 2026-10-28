import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminRoom,
  type AdminShowtime,
  type CreatedShowtime,
  DayType,
  type FieldError,
  type MovieStatus,
  Role,
  type SeatChange,
  SeatType,
  type ShowtimeConflict,
  type ShowtimeDates,
  type ShowtimeListItem,
  type ShowtimePreview,
  type ShowtimeSeatMap,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createFixtures, type Fixtures } from '../support/fixtures';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

type Method = 'get' | 'post' | 'put' | 'patch';

const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';
/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const CLEANUP_MINUTES = 15;
const DURATION = 100;

// Calendar (Asia/Ho_Chi_Minh, UTC+7): Sun 11-01 · Mon 11-02 · Wed 11-04 · Sat 11-07 · Sun 11-08.

/** A distinct price per cell, so a seat's price tells which seat type and day type it came from. */
const PRICES: Record<SeatType, Record<DayType, number>> = {
  STANDARD: { WEEKDAY: 75_000, WEEKEND: 90_000, HOLIDAY: 110_000 },
  VIP: { WEEKDAY: 95_000, WEEKEND: 115_000, HOLIDAY: 135_000 },
  COUPLE: { WEEKDAY: 100_000, WEEKEND: 120_000, HOLIDAY: 145_000 },
};

/** ISO with the Vietnam offset, the way the admin form sends it. */
const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const iso = (value: string): string => new FakeClock(value).now().toISOString();
const plusMinutes = (value: string, minutes: number): string =>
  new FakeClock(new FakeClock(value).now().getTime() + minutes * 60_000).now().toISOString();

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

describe('Showtimes, schedule and seat map (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let fixtures: Fixtures;
  let app: INestApplication<App>;
  let adminToken: string;
  let userToken: string;
  const clock = new FakeClock(NOW);

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        { SHOWTIME_CLEANUP_MINUTES: String(CLEANUP_MINUTES) },
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
    fixtures = createFixtures(db.prisma);
    [adminToken, userToken] = await Promise.all([
      accessTokenFor(app, db.prisma, Role.ADMIN),
      accessTokenFor(app, db.prisma, Role.USER),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(async () => {
    clock.set(NOW);
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
    await db.prisma.holiday.deleteMany();
  });

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const as = (token: string | undefined, method: Method, path: string, body?: object) => {
    const req = http()[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const admin = (method: Method, path: string, body?: object) => as(adminToken, method, path, body);
  const anonymous = (path: string) => http().get(path);

  let roomCounter = 0;
  async function createRoom(rows: number, cols: number): Promise<AdminRoom> {
    roomCounter += 1;
    const res = await admin('post', '/admin/rooms', {
      name: `Phòng ST ${roomCounter}`,
      rows,
      cols,
    });
    expect(res.status).toBe(201);
    return bodyOf<AdminRoom>(res);
  }

  const idsOf = (room: AdminRoom) =>
    new Map(room.seats.map((seat) => [`${seat.row}${seat.number}`, seat.id]));

  const patchSeats = (roomId: string, changes: SeatChange[]) =>
    admin('patch', `/admin/rooms/${roomId}/seats`, { changes });

  /**
   * 3×4 room: row A VIP, C1–C2 a couple pair, B4 switched off. 11 active seats:
   * 4 VIP, 5 STANDARD (B1–B3, C3–C4), 2 COUPLE.
   */
  async function mixedRoom(): Promise<{ room: AdminRoom; id: Map<string, string> }> {
    const room = await createRoom(3, 4);
    const id = idsOf(room);
    const seat = (label: string) => id.get(label)!;
    const res = await patchSeats(room.id, [
      ...['A1', 'A2', 'A3', 'A4'].map((label) => ({ seatId: seat(label), type: 'VIP' as const })),
      { seatId: seat('C1'), type: 'COUPLE', coupleWith: seat('C2') },
      { seatId: seat('C2'), type: 'COUPLE', coupleWith: seat('C1') },
      { seatId: seat('B4'), isActive: false },
    ]);
    expect(res.status).toBe(200);
    return { room: bodyOf<AdminRoom>(res), id };
  }

  async function movie(status?: MovieStatus, duration = DURATION) {
    const created = await fixtures.movie();
    return db.prisma.movie.update({
      where: { id: created.id },
      data: { duration, ...(status ? { status } : {}) },
    });
  }

  const postShowtime = (body: { movieId: string; roomId: string; startsAt: string }) =>
    admin('post', '/admin/showtimes', body);

  async function createShowtime(movieId: string, roomId: string, startsAt: string) {
    const res = await postShowtime({ movieId, roomId, startsAt });
    expect(res.status).toBe(201);
    return bodyOf<CreatedShowtime>(res);
  }

  const cancel = (id: string, token = adminToken) =>
    as(token, 'post', `/admin/showtimes/${id}/cancel`);

  async function seatRows(showtimeId: string) {
    return db.prisma.$queryRaw<
      {
        seat_id: string;
        label: string;
        type: SeatType;
        status: string;
        price: number;
        booking_id: string | null;
      }[]
    >`
      SELECT ss.seat_id, s."row" || s.number AS label, s.type::text AS type,
             ss.status::text AS status, ss.price, ss.booking_id
      FROM showtime_seats ss JOIN seats s ON s.id = ss.seat_id
      WHERE ss.showtime_id = ${showtimeId}::uuid
      ORDER BY s."row", s.number`;
  }

  const showtimeCount = (roomId: string) => db.prisma.showtime.count({ where: { roomId } });

  /** Marks a seat HELD (or SOLD) by a new booking, the way phase 2 will. */
  async function occupy(
    showtimeId: string,
    seatId: string,
    status: 'HELD' | 'SOLD',
    heldUntil: string | null = null,
  ) {
    const user = await fixtures.user();
    const booking = await fixtures.booking(user.id, showtimeId);
    await db.prisma.showtimeSeat.update({
      where: { showtimeId_seatId: { showtimeId, seatId } },
      data: {
        status,
        bookingId: booking.id,
        heldUntil: heldUntil === null ? null : new FakeClock(heldUntil).now(),
      },
    });
  }

  /** Overlapping non-cancelled showtime pairs in any room — must always be empty. */
  const overlappingPairs = () =>
    db.prisma.$queryRaw<{ a: string; b: string }[]>`
      SELECT a.id AS a, b.id AS b
      FROM showtimes a JOIN showtimes b
        ON a.room_id = b.room_id AND a.id < b.id
       AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
      WHERE a.status <> 'CANCELLED' AND b.status <> 'CANCELLED'`;

  // ─── Access control ───

  describe('role access', () => {
    const body = { movieId: UNKNOWN_ID, roomId: UNKNOWN_ID, startsAt: vn('2026-11-02', '19:30') };
    const routes: [Method, string, object | undefined][] = [
      ['get', '/admin/showtimes', undefined],
      ['get', `/admin/showtimes/preview?movieId=${UNKNOWN_ID}&roomId=${UNKNOWN_ID}`, undefined],
      ['post', '/admin/showtimes', body],
      ['post', `/admin/showtimes/${UNKNOWN_ID}/cancel`, undefined],
    ];

    it.each(routes)('%s %s: 401 without a token, 403 for USER', async (method, path, payload) => {
      expect((await as(undefined, method, path, payload)).status).toBe(401);

      const user = await as(userToken, method, path, payload);
      expect(user.status).toBe(403);
      expect(errorOf(user).code).toBe('FORBIDDEN');
    });

    it('the schedule, dates and seat map are public', async () => {
      expect((await anonymous(`/showtimes?movieId=${UNKNOWN_ID}`)).status).toBe(200);
      expect((await anonymous(`/showtimes/dates?movieId=${UNKNOWN_ID}`)).status).toBe(200);
      expect((await anonymous(`/showtimes/${UNKNOWN_ID}/seats`)).status).toBe(404);
    });
  });

  // ─── 1.13 Create ───

  describe('create', () => {
    it('201: one AVAILABLE ShowtimeSeat per active seat, priced by seat type × WEEKDAY', async () => {
      const { room, id } = await mixedRoom();
      const film = await movie();
      const startsAt = vn('2026-11-02', '19:30'); // Monday

      const created = await createShowtime(film.id, room.id, startsAt);

      expect(created).toMatchObject({
        status: 'SCHEDULED',
        dayType: DayType.WEEKDAY,
        movie: { id: film.id, duration: DURATION },
        room: { id: room.id, name: room.name },
        startsAt: iso(startsAt),
        // 19:30 + 100 min film + 15 min cleaning = 21:25 in Vietnam.
        endsAt: iso(vn('2026-11-02', '21:25')),
        seatCount: 11,
        soldCount: 0,
        heldCount: 0,
      });
      expect(created.seats.map((seat) => [seat.label, seat.price])).toEqual([
        ['A1', 95_000],
        ['A2', 95_000],
        ['A3', 95_000],
        ['A4', 95_000],
        ['B1', 75_000],
        ['B2', 75_000],
        ['B3', 75_000],
        ['C1', 100_000],
        ['C2', 100_000],
        ['C3', 75_000],
        ['C4', 75_000],
      ]);

      const rows = await seatRows(created.id);
      expect(rows).toHaveLength(11);
      expect(rows.map((row) => row.label)).not.toContain('B4');
      expect(rows.every((row) => row.status === 'AVAILABLE' && row.booking_id === null)).toBe(true);
      expect(rows.map((row) => [row.label, row.type, row.price])).toEqual(
        created.seats.map((seat) => [seat.label, seat.type, seat.price]),
      );
      expect(rows.find((row) => row.seat_id === id.get('C1'))?.price).toBe(100_000);
    });

    it('a COMING_SOON movie can be scheduled', async () => {
      const room = await createRoom(1, 2);
      const film = await movie('COMING_SOON');

      await createShowtime(film.id, room.id, vn('2026-11-02', '10:00'));
    });

    it('422 MOVIE_ENDED, 404 MOVIE_NOT_FOUND / ROOM_NOT_FOUND; nothing is written', async () => {
      const room = await createRoom(1, 2);
      const ended = await movie('ENDED');
      const film = await movie();
      const startsAt = vn('2026-11-02', '10:00');

      const endedRes = await postShowtime({ movieId: ended.id, roomId: room.id, startsAt });
      expect(endedRes.status).toBe(422);
      expect(errorOf(endedRes).code).toBe('MOVIE_ENDED');

      const noMovie = await postShowtime({ movieId: UNKNOWN_ID, roomId: room.id, startsAt });
      expect(noMovie.status).toBe(404);
      expect(errorOf(noMovie).code).toBe('MOVIE_NOT_FOUND');

      const noRoom = await postShowtime({ movieId: film.id, roomId: UNKNOWN_ID, startsAt });
      expect(noRoom.status).toBe(404);
      expect(errorOf(noRoom).code).toBe('ROOM_NOT_FOUND');

      expect(await showtimeCount(room.id)).toBe(0);
    });

    it.each([
      ['in the past', vn('2026-11-01', '16:59')],
      ['exactly now', vn('2026-11-01', '17:00')],
      ['without an offset', '2026-11-02T19:30:00'],
      ['not a date', 'tomorrow'],
    ])('400 VALIDATION_FAILED (startsAt) for a start %s', async (_label, startsAt) => {
      const room = await createRoom(1, 2);
      const film = await movie();

      const res = await postShowtime({ movieId: film.id, roomId: room.id, startsAt });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect((errorOf(res).details as FieldError[]).map((d) => d.field)).toEqual(['startsAt']);
      expect(await showtimeCount(room.id)).toBe(0);
    });

    it('a Saturday showtime is WEEKEND', async () => {
      const room = await createRoom(1, 2);
      const created = await createShowtime((await movie()).id, room.id, vn('2026-11-07', '14:00'));

      expect(created.dayType).toBe(DayType.WEEKEND);
      expect(created.seats.map((seat) => seat.price)).toEqual([90_000, 90_000]);
    });

    it('crossing midnight: 23:30 Sunday (Vietnam) → 01:25 Monday is priced WEEKEND', async () => {
      const room = await createRoom(1, 2);
      const startsAt = vn('2026-11-08', '23:30'); // 16:30Z, still Sunday in Vietnam

      const created = await createShowtime((await movie()).id, room.id, startsAt);

      expect(created.startsAt).toBe('2026-11-08T16:30:00.000Z');
      expect(created.endsAt).toBe(iso(vn('2026-11-09', '01:25')));
      expect(created.dayType).toBe(DayType.WEEKEND);
      expect((await seatRows(created.id)).map((row) => row.price)).toEqual([90_000, 90_000]);
    });

    it('a day in the Holiday table is HOLIDAY (Wednesday 2026-11-04)', async () => {
      expect((await admin('post', '/admin/holidays', { date: '2026-11-04' })).status).toBe(201);
      const { room } = await mixedRoom();

      const created = await createShowtime((await movie()).id, room.id, vn('2026-11-04', '19:00'));

      expect(created.dayType).toBe(DayType.HOLIDAY);
      const priceByType = new Map(created.seats.map((seat) => [seat.type, seat.price]));
      expect(Object.fromEntries(priceByType)).toEqual({
        VIP: 135_000,
        STANDARD: 110_000,
        COUPLE: 145_000,
      });
    });

    it('prices are a snapshot: later SeatPrice and Holiday edits never change a showtime', async () => {
      const room = await createRoom(1, 3);
      const film = await movie();
      const before = await createShowtime(film.id, room.id, vn('2026-11-02', '10:00'));

      const put = await admin('put', '/admin/seat-prices/STANDARD/WEEKDAY', { price: 80_000 });
      expect(put.status).toBe(200);
      expect((await admin('post', '/admin/holidays', { date: '2026-11-02' })).status).toBe(201);

      // The existing showtime keeps the price locked at creation…
      expect((await seatRows(before.id)).map((row) => row.price)).toEqual([75_000, 75_000, 75_000]);
      const map = bodyOf<ShowtimeSeatMap>(await anonymous(`/showtimes/${before.id}/seats`));
      expect(map.seats.map((seat) => seat.price)).toEqual([75_000, 75_000, 75_000]);

      // …while a new one the same day takes today's rules (now a holiday).
      const after = await createShowtime(film.id, room.id, vn('2026-11-02', '14:00'));
      expect(after.dayType).toBe(DayType.HOLIDAY);
      expect(after.seats.map((seat) => seat.price)).toEqual([110_000, 110_000, 110_000]);

      // And a new weekday showtime gets the edited weekday price.
      const weekday = await createShowtime(film.id, room.id, vn('2026-11-03', '10:00'));
      expect(weekday.seats.map((seat) => seat.price)).toEqual([80_000, 80_000, 80_000]);
    });

    it('locks the room layout until the showtime is cancelled', async () => {
      const room = await createRoom(1, 2);
      const created = await createShowtime((await movie()).id, room.id, vn('2026-11-02', '10:00'));
      const edit = [{ seatId: room.seats[0]!.id, isActive: false }];

      const locked = await patchSeats(room.id, edit);
      expect(locked.status).toBe(409);
      expect(errorOf(locked).code).toBe('ROOM_IN_USE');

      expect((await cancel(created.id)).status).toBe(200);
      expect((await patchSeats(room.id, edit)).status).toBe(200);
    });
  });

  // ─── Overlaps ───

  describe('overlaps (exclusion constraint, half-open [startsAt, endsAt))', () => {
    it('409 SHOWTIME_OVERLAP in the same room, listing the showtime in the way', async () => {
      const room = await createRoom(1, 2);
      const film = await movie();
      const first = await createShowtime(film.id, room.id, vn('2026-11-02', '19:00')); // → 20:55

      const res = await postShowtime({
        movieId: film.id,
        roomId: room.id,
        startsAt: vn('2026-11-02', '20:54'),
      });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SHOWTIME_OVERLAP');
      const details = errorOf(res).details as { field: string; conflicts: ShowtimeConflict[] };
      expect(details.field).toBe('startsAt');
      expect(details.conflicts).toEqual([
        { id: first.id, movieTitle: film.title, startsAt: first.startsAt, endsAt: first.endsAt },
      ]);
      // Nothing half-written: one showtime, and only its seats.
      expect(await showtimeCount(room.id)).toBe(1);
      expect(await db.prisma.showtimeSeat.count({ where: { seat: { roomId: room.id } } })).toBe(2);
    });

    it('back to back is allowed: a showtime may start exactly when the previous one ends', async () => {
      const room = await createRoom(1, 2);
      const film = await movie();
      const first = await createShowtime(film.id, room.id, vn('2026-11-02', '19:00'));
      expect(first.endsAt).toBe(iso(vn('2026-11-02', '20:55')));

      // Starts at first.endsAt…
      const next = await createShowtime(film.id, room.id, vn('2026-11-02', '20:55'));
      // …and one that ends exactly at first.startsAt (17:05 + 115 min = 19:00).
      const before = await createShowtime(film.id, room.id, vn('2026-11-02', '17:05'));

      expect(next.startsAt).toBe(first.endsAt);
      expect(before.endsAt).toBe(first.startsAt);
      expect(await overlappingPairs()).toEqual([]);
    });

    it('the same time in another room is fine', async () => {
      const [roomA, roomB] = [await createRoom(1, 2), await createRoom(1, 2)];
      const film = await movie();

      await createShowtime(film.id, roomA.id, vn('2026-11-02', '19:00'));
      await createShowtime(film.id, roomB.id, vn('2026-11-02', '19:00'));
    });

    it('a cancelled showtime does not block its slot', async () => {
      const room = await createRoom(1, 2);
      const film = await movie();
      const first = await createShowtime(film.id, room.id, vn('2026-11-02', '19:00'));
      expect((await cancel(first.id)).status).toBe(200);

      const again = await createShowtime(film.id, room.id, vn('2026-11-02', '19:30'));

      expect(again.status).toBe('SCHEDULED');
    });

    it('preview: endsAt, day type and the overlapping showtime, without writing', async () => {
      const room = await createRoom(1, 2);
      const film = await movie();
      const first = await createShowtime(film.id, room.id, vn('2026-11-07', '19:00'));
      const query = (startsAt: string) =>
        `/admin/showtimes/preview?movieId=${film.id}&roomId=${room.id}&startsAt=${encodeURIComponent(startsAt)}`;

      const clash = await admin('get', query(vn('2026-11-07', '20:00')));
      expect(clash.status).toBe(200);
      expect(bodyOf<ShowtimePreview>(clash)).toEqual({
        startsAt: iso(vn('2026-11-07', '20:00')),
        endsAt: iso(vn('2026-11-07', '21:55')),
        cleanupMinutes: CLEANUP_MINUTES,
        dayType: DayType.WEEKEND,
        conflicts: [
          { id: first.id, movieTitle: film.title, startsAt: first.startsAt, endsAt: first.endsAt },
        ],
      });

      const free = bodyOf<ShowtimePreview>(await admin('get', query(first.endsAt)));
      expect(free.conflicts).toEqual([]);
      expect(await showtimeCount(room.id)).toBe(1);

      const past = await admin('get', query(vn('2026-11-01', '09:00')));
      expect(past.status).toBe(400);
      expect(errorOf(past).code).toBe('VALIDATION_FAILED');
    });
  });

  // ─── 1.14 Cancel ───

  describe('cancel', () => {
    async function upcoming() {
      const room = await createRoom(1, 4);
      const created = await createShowtime((await movie()).id, room.id, vn('2026-11-02', '19:00'));
      return { room, created };
    }

    it('200 without bookings: CANCELLED, AVAILABLE seats kept as they are', async () => {
      const { created } = await upcoming();

      const res = await cancel(created.id);

      expect(res.status).toBe(200);
      expect(bodyOf<AdminShowtime>(res)).toMatchObject({ id: created.id, status: 'CANCELLED' });
      const rows = await seatRows(created.id);
      expect(rows).toHaveLength(4);
      expect(rows.every((row) => row.status === 'AVAILABLE')).toBe(true);
    });

    it('cancelling twice: 200 both times, the second changes nothing', async () => {
      const { created } = await upcoming();
      expect((await cancel(created.id)).status).toBe(200);
      const after = await db.prisma.showtime.findUniqueOrThrow({ where: { id: created.id } });

      clock.advance({ minutes: 5 });
      const again = await cancel(created.id);

      expect(again.status).toBe(200);
      expect(bodyOf<AdminShowtime>(again).status).toBe('CANCELLED');
      const unchanged = await db.prisma.showtime.findUniqueOrThrow({ where: { id: created.id } });
      expect(unchanged.updatedAt).toEqual(after.updatedAt);
    });

    it.each([
      ['a live HELD seat', 'HELD' as const, '2026-11-01T10:10:00Z'],
      [
        'an expired HELD seat (a late payment could still confirm it)',
        'HELD' as const,
        '2026-11-01T09:00:00Z',
      ],
      ['a SOLD seat', 'SOLD' as const, null],
    ])('409 SHOWTIME_HAS_BOOKINGS with %s; nothing changes', async (_label, status, heldUntil) => {
      const { created } = await upcoming();
      await occupy(created.id, created.seats[1]!.seatId, status, heldUntil);

      const res = await cancel(created.id);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SHOWTIME_HAS_BOOKINGS');
      expect(errorOf(res).details).toEqual({
        heldCount: status === 'HELD' ? 1 : 0,
        soldCount: status === 'SOLD' ? 1 : 0,
      });
      const row = await db.prisma.showtime.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.status).toBe('SCHEDULED');
    });

    it('409 SHOWTIME_STARTED once startsAt <= now', async () => {
      const { created } = await upcoming();
      clock.set(created.startsAt);
      // Access tokens live 15 minutes on the same clock: sign one at the new "now".
      const token = await accessTokenFor(app, db.prisma, Role.ADMIN);

      const res = await cancel(created.id, token);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SHOWTIME_STARTED');
    });

    it('404 SHOWTIME_NOT_FOUND for an unknown id, 400 for a malformed one', async () => {
      const unknown = await cancel(UNKNOWN_ID);
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('SHOWTIME_NOT_FOUND');
      expect((await cancel('nope')).status).toBe(400);
    });
  });

  // ─── Admin list ───

  describe('GET /admin/showtimes?date=', () => {
    it('lists every status of that Vietnam day with seat, sold and held counts', async () => {
      const room = await createRoom(1, 3);
      const film = await movie();
      const late = await createShowtime(film.id, room.id, vn('2026-11-05', '23:30')); // 16:30Z
      const early = await createShowtime(film.id, room.id, vn('2026-11-05', '08:00'));
      const cancelled = await createShowtime(film.id, room.id, vn('2026-11-05', '12:00'));
      expect((await cancel(cancelled.id)).status).toBe(200);
      // 02:00 on the 6th in Vietnam is still the 5th in UTC (19:00Z): not listed.
      await createShowtime(film.id, room.id, vn('2026-11-06', '02:00'));
      await occupy(late.id, late.seats[0]!.seatId, 'SOLD');
      await occupy(late.id, late.seats[1]!.seatId, 'HELD', '2026-11-01T09:00:00Z');

      const rows = bodyOf<AdminShowtime[]>(await admin('get', '/admin/showtimes?date=2026-11-05'));

      expect(rows.map((row) => [row.id, row.status])).toEqual([
        [early.id, 'SCHEDULED'],
        [cancelled.id, 'CANCELLED'],
        [late.id, 'SCHEDULED'],
      ]);
      expect(rows[2]).toMatchObject({ seatCount: 3, soldCount: 1, heldCount: 1 });
    });

    it('400 for a malformed date', async () => {
      expect((await admin('get', '/admin/showtimes?date=05-11-2026')).status).toBe(400);
    });
  });

  // ─── 1.15 Public schedule ───

  describe('GET /showtimes?movieId=&date=', () => {
    it('400 VALIDATION_FAILED without movieId', async () => {
      const res = await anonymous('/showtimes?date=2026-11-02');

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect((errorOf(res).details as FieldError[]).map((d) => d.field)).toEqual(['movieId']);
    });

    it('`date` is a day in Vietnam, not in UTC', async () => {
      const room = await createRoom(1, 2);
      const film = await movie();
      // 23:30 on the 2nd in Vietnam is 16:30Z on the 2nd; 00:30 on the 3rd is 17:30Z on the 2nd.
      const lateOn2nd = await createShowtime(film.id, room.id, vn('2026-11-02', '23:30'));
      const earlyOn3rd = await createShowtime(film.id, room.id, vn('2026-11-03', '01:30'));
      // 06:00 on the 2nd in Vietnam is 23:00Z on the 1st.
      const morningOn2nd = await createShowtime(film.id, room.id, vn('2026-11-02', '06:00'));

      const on2nd = bodyOf<ShowtimeListItem[]>(
        await anonymous(`/showtimes?movieId=${film.id}&date=2026-11-02`),
      );
      const on3rd = bodyOf<ShowtimeListItem[]>(
        await anonymous(`/showtimes?movieId=${film.id}&date=2026-11-03`),
      );

      expect(on2nd.map((item) => item.id)).toEqual([morningOn2nd.id, lateOn2nd.id]);
      expect(on3rd.map((item) => item.id)).toEqual([earlyOn3rd.id]);
      expect(on2nd[0]).toEqual({
        id: morningOn2nd.id,
        startsAt: morningOn2nd.startsAt,
        endsAt: morningOn2nd.endsAt,
        room: { id: room.id, name: room.name },
        availableSeats: 2,
        totalSeats: 2,
      });
    });

    it('hides cancelled showtimes and those that have started; other movies are not listed', async () => {
      const room = await createRoom(1, 2);
      const film = await movie();
      const other = await movie();
      const soon = await createShowtime(film.id, room.id, vn('2026-11-02', '08:00'));
      const later = await createShowtime(film.id, room.id, vn('2026-11-02', '12:00'));
      const cancelled = await createShowtime(film.id, room.id, vn('2026-11-02', '16:00'));
      await createShowtime(other.id, room.id, vn('2026-11-02', '20:00'));
      expect((await cancel(cancelled.id)).status).toBe(200);
      const list = async () =>
        bodyOf<ShowtimeListItem[]>(
          await anonymous(`/showtimes?movieId=${film.id}&date=2026-11-02`),
        ).map((item) => item.id);

      expect(await list()).toEqual([soon.id, later.id]);

      clock.set(soon.startsAt); // started: startsAt <= now
      expect(await list()).toEqual([later.id]);
    });

    it('counts an expired hold as available, a live hold or a sale as taken', async () => {
      const room = await createRoom(1, 4);
      const film = await movie();
      const created = await createShowtime(film.id, room.id, vn('2026-11-02', '08:00'));
      const [a, b, c] = created.seats;
      await occupy(created.id, a!.seatId, 'SOLD');
      await occupy(created.id, b!.seatId, 'HELD', '2026-11-01T10:10:00Z');
      await occupy(created.id, c!.seatId, 'HELD', '2026-11-01T09:59:00Z'); // expired

      const [item] = bodyOf<ShowtimeListItem[]>(
        await anonymous(`/showtimes?movieId=${film.id}&date=2026-11-02`),
      );
      expect(item).toMatchObject({ availableSeats: 2, totalSeats: 4 });

      clock.set('2026-11-01T10:10:00Z'); // b's hold ends now
      const [again] = bodyOf<ShowtimeListItem[]>(
        await anonymous(`/showtimes?movieId=${film.id}&date=2026-11-02`),
      );
      expect(again).toMatchObject({ availableSeats: 3 });
    });

    it('/showtimes/dates lists Vietnam days with upcoming showtimes, ascending', async () => {
      const room = await createRoom(1, 2);
      const film = await movie();
      await createShowtime(film.id, room.id, vn('2026-11-05', '10:00'));
      await createShowtime(film.id, room.id, vn('2026-11-03', '00:30')); // 2026-11-02T17:30Z
      await createShowtime(film.id, room.id, vn('2026-11-03', '20:00'));
      const cancelled = await createShowtime(film.id, room.id, vn('2026-11-04', '10:00'));
      expect((await cancel(cancelled.id)).status).toBe(200);

      const res = await anonymous(`/showtimes/dates?movieId=${film.id}`);

      expect(bodyOf<ShowtimeDates>(res)).toEqual({ dates: ['2026-11-03', '2026-11-05'] });
    });
  });

  describe('GET /showtimes/:id/seats', () => {
    it('room grid + every seat; expired holds are AVAILABLE; nothing is written', async () => {
      const { room } = await mixedRoom();
      const film = await movie();
      const created = await createShowtime(film.id, room.id, vn('2026-11-02', '19:30'));
      const seatOf = (label: string) => created.seats.find((seat) => seat.label === label)!.seatId;
      await occupy(created.id, seatOf('A1'), 'SOLD');
      await occupy(created.id, seatOf('A2'), 'HELD', '2026-11-01T10:10:00Z');
      await occupy(created.id, seatOf('A3'), 'HELD', '2026-11-01T09:59:59Z');

      const res = await anonymous(`/showtimes/${created.id}/seats`);

      expect(res.status).toBe(200);
      const map = bodyOf<ShowtimeSeatMap>(res);
      expect(map.showtime).toEqual({
        id: created.id,
        startsAt: created.startsAt,
        endsAt: created.endsAt,
        status: 'SCHEDULED',
        movie: {
          id: film.id,
          title: film.title,
          slug: film.slug,
          duration: DURATION,
          ageRating: film.ageRating,
        },
        room: { id: room.id, name: room.name, rows: 3, cols: 4 },
      });
      expect(map.seats).toHaveLength(11);
      expect(map.seats.map((seat) => seat.label)).not.toContain('B4');
      const byLabel = new Map(map.seats.map((seat) => [seat.label, seat]));
      expect(byLabel.get('A1')).toMatchObject({ status: 'SOLD', type: 'VIP', price: 95_000 });
      expect(byLabel.get('A2')?.status).toBe('HELD');
      expect(byLabel.get('A3')?.status).toBe('AVAILABLE');
      expect(byLabel.get('C1')).toMatchObject({
        row: 'C',
        number: 1,
        type: 'COUPLE',
        isActive: true,
        price: 100_000,
        status: 'AVAILABLE',
      });
      expect(byLabel.get('C1')?.coupleGroup).not.toBeNull();
      expect(byLabel.get('C1')?.coupleGroup).toBe(byLabel.get('C2')?.coupleGroup);

      // Lazy expiry is a read-side rule: the row is still HELD in the database.
      const a3 = (await seatRows(created.id)).find((row) => row.label === 'A3');
      expect(a3?.status).toBe('HELD');

      // Once A2's hold ends, it shows AVAILABLE too.
      clock.set('2026-11-01T10:10:00Z');
      const later = bodyOf<ShowtimeSeatMap>(await anonymous(`/showtimes/${created.id}/seats`));
      expect(later.seats.find((seat) => seat.label === 'A2')?.status).toBe('AVAILABLE');
    });

    it('404 SHOWTIME_NOT_FOUND for a cancelled showtime (and an unknown one)', async () => {
      const room = await createRoom(1, 2);
      const created = await createShowtime((await movie()).id, room.id, vn('2026-11-02', '10:00'));
      expect((await cancel(created.id)).status).toBe(200);

      for (const id of [created.id, UNKNOWN_ID]) {
        const res = await anonymous(`/showtimes/${id}/seats`);
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('SHOWTIME_NOT_FOUND');
      }
    });
  });

  // ─── Concurrency ───

  describe('concurrency', () => {
    it('10 simultaneous overlapping creates in one room: exactly one 201, nine 409, no 5xx', async () => {
      const room = await createRoom(2, 5);
      const film = await movie();
      // Starts 0–9 minutes apart: every pair overlaps.
      const bodies = Array.from({ length: 10 }, (_, i) => ({
        movieId: film.id,
        roomId: room.id,
        startsAt: plusMinutes(vn('2026-11-02', '19:00'), i),
      }));

      const responses = await Promise.all(bodies.map((body) => postShowtime(body)));

      const statuses = responses.map((res) => res.status).sort();
      expect(statuses).toEqual([201, ...Array<number>(9).fill(409)]);
      for (const res of responses.filter((r) => r.status === 409)) {
        expect(errorOf(res).code).toBe('SHOWTIME_OVERLAP');
      }
      expect(await showtimeCount(room.id)).toBe(1);
      const winner = bodyOf<CreatedShowtime>(responses.find((res) => res.status === 201)!);
      expect(await seatRows(winner.id)).toHaveLength(10);
      expect(await overlappingPairs()).toEqual([]);
    });

    it('creates racing seat edits on the same room: no deadlock, no 5xx, seats always match the room', async () => {
      const next = random(20_261_102);
      const film = await movie();
      const ROUNDS = 12;
      const statuses = new Map<string, number>();
      const count = (key: string) => statuses.set(key, (statuses.get(key) ?? 0) + 1);

      for (let round = 0; round < ROUNDS; round++) {
        // A fresh room each round: once a showtime exists the layout is locked for good.
        const room = await createRoom(3, 6);
        const seats = room.seats;
        // 4 creates in non-overlapping slots (115 min each, 3 h apart)…
        const creates = Array.from(
          { length: 4 },
          (_, i) => () =>
            postShowtime({
              movieId: film.id,
              roomId: room.id,
              startsAt: plusMinutes(vn('2026-11-02', '08:00'), 180 * i),
            }).then((res) => ({ kind: 'create' as const, res })),
        );
        // …and 4 edits that switch random seats on/off (no couples, so never 422).
        const edits = Array.from({ length: 4 }, () => {
          const picked = new Map<string, boolean>();
          for (let k = 0; k < 3; k++) {
            const seat = seats[Math.floor(next() * seats.length)]!;
            picked.set(seat.id, next() < 0.5);
          }
          const changes = [...picked].map(([seatId, isActive]) => ({ seatId, isActive }));
          return () => patchSeats(room.id, changes).then((res) => ({ kind: 'edit' as const, res }));
        });
        // Fisher–Yates with the seeded PRNG: a different interleaving every round.
        const work = [...creates, ...edits];
        for (let i = work.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          [work[i], work[j]] = [work[j]!, work[i]!];
        }

        const results = await Promise.all(work.map((start) => start()));

        for (const { kind, res } of results) {
          count(`${kind} ${res.status}`);
          expect(res.status).toBeLessThan(500);
          if (kind === 'create') expect(res.status).toBe(201);
          else expect([200, 409]).toContain(res.status);
          if (kind === 'edit' && res.status === 409) expect(errorOf(res).code).toBe('ROOM_IN_USE');
        }

        // Every showtime has exactly the room's active seats, priced by type, all AVAILABLE.
        // (After the first showtime commits no edit can succeed, so the final layout is the one
        // every create must have read.)
        const active = await db.prisma.seat.findMany({
          where: { roomId: room.id, isActive: true },
          select: { id: true, type: true },
          orderBy: { id: 'asc' },
        });
        const created = results
          .filter((r) => r.kind === 'create')
          .map((r) => bodyOf<CreatedShowtime>(r.res));
        expect(created).toHaveLength(4);
        for (const showtime of created) {
          const rows = await db.prisma.showtimeSeat.findMany({
            where: { showtimeId: showtime.id },
            select: { seatId: true, price: true, status: true },
            orderBy: { seatId: 'asc' },
          });
          expect(rows.map((row) => row.seatId)).toEqual(active.map((seat) => seat.id));
          expect(rows.every((row) => row.status === 'AVAILABLE')).toBe(true);
          expect(rows.map((row) => row.price)).toEqual(
            active.map((seat) => PRICES[seat.type].WEEKDAY),
          );
          expect(showtime.seats.map((seat) => seat.seatId).sort()).toEqual(
            active.map((seat) => seat.id),
          );
        }
      }

      expect(await overlappingPairs()).toEqual([]);
      // Sanity: edits really raced the creates (some won before them, some were refused after).
      expect(statuses.get('edit 409') ?? 0).toBeGreaterThan(0);
      expect(statuses.get('edit 200') ?? 0).toBeGreaterThan(0);
    });
  });
});
