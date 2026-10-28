import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminRoom,
  type AdminRoomSummary,
  type AdminSeat,
  type CoupleViolation,
  Role,
  type RoomLock,
  type SeatChange,
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

type Method = 'get' | 'post' | 'patch' | 'delete';

const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';
/** "Now" for every request: showtimes are placed around it. */
const NOW = '2026-11-01T10:00:00.000Z';

interface SeatRow {
  id: string;
  row: string;
  number: number;
  type: string;
  is_active: boolean;
  couple_group: number | null;
}

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

describe('Rooms & seat layout (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let fixtures: Fixtures;
  let app: INestApplication<App>;
  let adminToken: string;
  let userToken: string;
  const clock = new FakeClock(NOW);

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
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

  beforeEach(() => clock.set(NOW));

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const as = (token: string | undefined, method: Method, path: string, body?: object) => {
    const req = http()[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const admin = (method: Method, path: string, body?: object) => as(adminToken, method, path, body);

  let roomCounter = 0;
  async function createRoom(rows = 4, cols = 6, name?: string): Promise<AdminRoom> {
    roomCounter += 1;
    const res = await admin('post', '/admin/rooms', {
      name: name ?? `Phòng test ${roomCounter}`,
      rows,
      cols,
    });
    expect(res.status).toBe(201);
    return bodyOf<AdminRoom>(res);
  }

  /** Seat ids by label (`A5`). */
  const idsOf = (room: AdminRoom) =>
    new Map(room.seats.map((seat) => [`${seat.row}${seat.number}`, seat.id]));

  const patchSeats = (roomId: string, changes: SeatChange[]) =>
    admin('patch', `/admin/rooms/${roomId}/seats`, { changes });

  async function seatRows(roomId: string): Promise<SeatRow[]> {
    return db.prisma.$queryRaw<SeatRow[]>`
      SELECT id, "row", number, type::text AS type, is_active, couple_group
      FROM seats WHERE room_id = ${roomId}::uuid ORDER BY "row", number`;
  }

  /** Every couple rule as SQL; each query returns the offending rows (expected: none). */
  async function layoutViolations(roomId: string): Promise<unknown[]> {
    const typeVsGroup = await db.prisma.$queryRaw<unknown[]>`
      SELECT id FROM seats
      WHERE room_id = ${roomId}::uuid AND (type = 'COUPLE') <> (couple_group IS NOT NULL)`;
    const badPairs = await db.prisma.$queryRaw<unknown[]>`
      SELECT couple_group FROM seats
      WHERE room_id = ${roomId}::uuid AND couple_group IS NOT NULL
      GROUP BY couple_group
      HAVING count(*) <> 2
          OR count(DISTINCT "row") <> 1
          OR max(number) - min(number) <> 1
          OR count(DISTINCT is_active) <> 1`;
    return [...typeVsGroup, ...badPairs];
  }

  async function showtimeIn(roomId: string, startsAt: string, endsAt: string, cancelled = false) {
    const movie = await fixtures.movie();
    return fixtures.showtime({
      movieId: movie.id,
      roomId,
      startsAt,
      endsAt,
      status: cancelled ? 'CANCELLED' : undefined,
    });
  }

  const violationsOf = (res: request.Response) =>
    (errorOf(res).details as { violations: CoupleViolation[] }).violations.map((v) => ({
      reason: v.reason,
      seats: v.seats,
    }));

  // ─── Access control ───

  describe('role access', () => {
    const routes: [Method, string, object | undefined][] = [
      ['get', '/admin/rooms', undefined],
      ['post', '/admin/rooms', { name: 'X', rows: 1, cols: 1 }],
      ['get', `/admin/rooms/${UNKNOWN_ID}`, undefined],
      ['patch', `/admin/rooms/${UNKNOWN_ID}`, { name: 'X' }],
      ['delete', `/admin/rooms/${UNKNOWN_ID}`, undefined],
      ['patch', `/admin/rooms/${UNKNOWN_ID}/seats`, { changes: [{ seatId: UNKNOWN_ID }] }],
    ];

    it.each(routes)('%s %s: 401 without a token, 403 for USER', async (method, path, body) => {
      const anonymous = await as(undefined, method, path, body);
      expect(anonymous.status).toBe(401);

      const user = await as(userToken, method, path, body);
      expect(user.status).toBe(403);
      expect(errorOf(user).code).toBe('FORBIDDEN');
    });
  });

  // ─── CRUD ───

  describe('rooms CRUD', () => {
    it('creates a 10×12 room with 120 STANDARD seats, all on (201)', async () => {
      const room = await createRoom(10, 12);

      expect(room).toMatchObject({ rows: 10, cols: 12, lock: null });
      expect(room.seats).toHaveLength(120);
      expect(room.seats[0]).toMatchObject({ row: 'A', number: 1, type: 'STANDARD' });
      expect(room.seats.at(-1)).toMatchObject({ row: 'J', number: 12 });
      expect(room.seats.every((s) => s.isActive && s.coupleGroup === null)).toBe(true);
      expect(await db.prisma.seat.count({ where: { roomId: room.id } })).toBe(120);
    });

    it('409 ROOM_NAME_TAKEN for a duplicate name; nothing is created', async () => {
      const room = await createRoom(2, 2, 'Phòng trùng tên');
      const before = await db.prisma.seat.count();

      const res = await admin('post', '/admin/rooms', {
        name: '  Phòng trùng tên ',
        rows: 3,
        cols: 3,
      });

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'ROOM_NAME_TAKEN', details: { field: 'name' } });
      expect(await db.prisma.seat.count()).toBe(before);
      expect(await db.prisma.room.count({ where: { name: room.name } })).toBe(1);
    });

    it.each([
      { rows: 0, cols: 5 },
      { rows: 27, cols: 5 },
      { rows: 5, cols: 31 },
      { rows: 5.5, cols: 5 },
    ])('400 VALIDATION_FAILED for %o', async (size) => {
      const res = await admin('post', '/admin/rooms', { name: 'Phòng lỗi', ...size });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('lists rooms by name (numeric aware) with seat and active seat counts', async () => {
      const ten = await createRoom(2, 3, 'Sảnh 10');
      const two = await createRoom(2, 2, 'Sảnh 2');
      const ids = idsOf(two);
      expect((await patchSeats(two.id, [{ seatId: ids.get('A1')!, isActive: false }])).status).toBe(
        200,
      );

      const res = await admin('get', '/admin/rooms');
      expect(res.status).toBe(200);
      const list = bodyOf<AdminRoomSummary[]>(res).filter((room) => room.name.startsWith('Sảnh'));
      expect(list.map((room) => room.name)).toEqual(['Sảnh 2', 'Sảnh 10']);
      expect(list[0]).toMatchObject({ id: two.id, seatCount: 4, activeSeatCount: 3 });
      expect(list[1]).toMatchObject({ id: ten.id, seatCount: 6, activeSeatCount: 6 });
    });

    it('404 ROOM_NOT_FOUND for unknown ids, 400 for malformed ones', async () => {
      for (const [method, path, body] of [
        ['get', `/admin/rooms/${UNKNOWN_ID}`, undefined],
        ['patch', `/admin/rooms/${UNKNOWN_ID}`, { name: 'X' }],
        ['delete', `/admin/rooms/${UNKNOWN_ID}`, undefined],
        ['patch', `/admin/rooms/${UNKNOWN_ID}/seats`, { changes: [{ seatId: UNKNOWN_ID }] }],
      ] as [Method, string, object | undefined][]) {
        const res = await admin(method, path, body);
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('ROOM_NOT_FOUND');
      }
      expect((await admin('get', '/admin/rooms/not-a-uuid')).status).toBe(400);
    });

    it('renames a room; a taken name is 409', async () => {
      const room = await createRoom(1, 2);
      const other = await createRoom(1, 2);

      const res = await admin('patch', `/admin/rooms/${room.id}`, { name: 'Phòng đổi tên' });
      expect(res.status).toBe(200);
      expect(bodyOf<AdminRoom>(res)).toMatchObject({ name: 'Phòng đổi tên', rows: 1, cols: 2 });

      const clash = await admin('patch', `/admin/rooms/${other.id}`, { name: 'Phòng đổi tên' });
      expect(clash.status).toBe(409);
      expect(errorOf(clash).code).toBe('ROOM_NAME_TAKEN');
    });

    it('deletes a room without showtimes (204) together with its seats', async () => {
      const room = await createRoom(3, 3);

      expect((await admin('delete', `/admin/rooms/${room.id}`)).status).toBe(204);
      expect(await db.prisma.room.count({ where: { id: room.id } })).toBe(0);
      expect(await db.prisma.seat.count({ where: { roomId: room.id } })).toBe(0);
    });

    it.each([
      ['an upcoming showtime', '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z', false],
      ['a finished showtime', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z', false],
      ['a cancelled showtime', '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z', true],
    ])('409 ROOM_HAS_SHOWTIMES with %s', async (_case, startsAt, endsAt, cancelled) => {
      const room = await createRoom(2, 2);
      await showtimeIn(room.id, startsAt, endsAt, cancelled);

      const res = await admin('delete', `/admin/rooms/${room.id}`);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ROOM_HAS_SHOWTIMES',
        details: { showtimeCount: 1 },
      });
      expect(await db.prisma.seat.count({ where: { roomId: room.id } })).toBe(4);
    });
  });

  // ─── Seat layout ───

  describe('seat layout batches', () => {
    it('applies types, on/off and pairs in one batch and returns the whole new grid', async () => {
      const room = await createRoom(3, 6);
      const id = idsOf(room);

      const res = await patchSeats(room.id, [
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ seatId: id.get(`B${n}`)!, type: 'VIP' as const })),
        { seatId: id.get('C1')!, type: 'COUPLE', coupleWith: id.get('C2')! },
        { seatId: id.get('C2')!, type: 'COUPLE' },
        { seatId: id.get('C3')!, type: 'COUPLE', coupleWith: id.get('C4')! },
        { seatId: id.get('C4')!, type: 'COUPLE', coupleWith: id.get('C3')! },
        { seatId: id.get('A6')!, isActive: false },
      ]);

      expect(res.status).toBe(200);
      const after = bodyOf<AdminRoom>(res);
      expect(after.seats).toHaveLength(18);
      const seat = (label: string) => after.seats.find((s) => `${s.row}${s.number}` === label)!;
      expect(after.seats.filter((s) => s.type === 'VIP').map((s) => s.row)).toEqual(
        Array(6).fill('B'),
      );
      expect(seat('C1').coupleGroup).toBe(seat('C2').coupleGroup);
      expect(seat('C3').coupleGroup).toBe(seat('C4').coupleGroup);
      expect(seat('C1').coupleGroup).not.toBe(seat('C3').coupleGroup);
      expect(seat('A6').isActive).toBe(false);
      expect(await layoutViolations(room.id)).toEqual([]);
    });

    it('a batch with one bad element writes nothing (all-or-nothing)', async () => {
      const room = await createRoom(2, 4);
      const id = idsOf(room);
      const before = await seatRows(room.id);

      const res = await patchSeats(room.id, [
        { seatId: id.get('A1')!, type: 'VIP' },
        { seatId: id.get('A2')!, isActive: false },
        { seatId: id.get('B1')!, type: 'COUPLE', coupleWith: id.get('B3')! }, // not adjacent
        { seatId: id.get('B3')!, type: 'COUPLE' },
      ]);

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('INVALID_COUPLE');
      expect(violationsOf(res)).toEqual([{ reason: 'NOT_ADJACENT', seats: ['B1', 'B3'] }]);
      expect(await seatRows(room.id)).toEqual(before);
    });

    it('422 SEAT_NOT_FOUND for a seat of another room; nothing is written', async () => {
      const room = await createRoom(1, 2);
      const other = await createRoom(1, 2);
      const before = await seatRows(room.id);
      const foreign = other.seats[0]!.id;

      const res = await patchSeats(room.id, [
        { seatId: room.seats[0]!.id, type: 'VIP' },
        { seatId: foreign, type: 'VIP' },
      ]);

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'SEAT_NOT_FOUND',
        details: { seatIds: [foreign] },
      });
      expect(await seatRows(room.id)).toEqual(before);
      expect((await seatRows(other.id))[0]?.type).toBe('STANDARD');
    });

    it('couple pairs: create, reject cross-row, split by changing type, keep on/off together', async () => {
      const room = await createRoom(2, 4);
      const id = idsOf(room);
      const pair = (a: string, b: string): SeatChange[] => [
        { seatId: id.get(a)!, type: 'COUPLE', coupleWith: id.get(b)! },
        { seatId: id.get(b)!, type: 'COUPLE' },
      ];

      // Cross-row pair → INVALID_COUPLE.
      const crossRow = await patchSeats(room.id, pair('A1', 'B1'));
      expect(crossRow.status).toBe(422);
      expect(violationsOf(crossRow)).toEqual([{ reason: 'DIFFERENT_ROWS', seats: ['A1', 'B1'] }]);

      // Valid pair.
      expect((await patchSeats(room.id, pair('A1', 'A2'))).status).toBe(200);
      let rows = await seatRows(room.id);
      expect(rows[0]!.couple_group).not.toBeNull();
      expect(rows[0]!.couple_group).toBe(rows[1]!.couple_group);

      // One seat only switched off → COUPLE_INCONSISTENT.
      const halfOff = await patchSeats(room.id, [{ seatId: id.get('A1')!, isActive: false }]);
      expect(halfOff.status).toBe(422);
      expect(errorOf(halfOff).code).toBe('COUPLE_INCONSISTENT');
      expect(violationsOf(halfOff)).toEqual([{ reason: 'ACTIVE_MISMATCH', seats: ['A1', 'A2'] }]);

      // Both switched off → fine, still paired.
      const bothOff = await patchSeats(room.id, [
        { seatId: id.get('A1')!, isActive: false },
        { seatId: id.get('A2')!, isActive: false },
      ]);
      expect(bothOff.status).toBe(200);

      // Only one side changed away from COUPLE → the other would be left alone.
      const oneSide = await patchSeats(room.id, [{ seatId: id.get('A1')!, type: 'VIP' }]);
      expect(oneSide.status).toBe(422);
      expect(violationsOf(oneSide)).toEqual([{ reason: 'MISSING_PARTNER', seats: ['A2', 'A1'] }]);

      // Both sides changed → the pair is split automatically.
      const split = await patchSeats(room.id, [
        { seatId: id.get('A1')!, type: 'STANDARD', isActive: true },
        { seatId: id.get('A2')!, type: 'STANDARD', isActive: true, coupleWith: null },
      ]);
      expect(split.status).toBe(200);
      rows = await seatRows(room.id);
      expect(rows.slice(0, 2).map((r) => [r.type, r.couple_group, r.is_active])).toEqual([
        ['STANDARD', null, true],
        ['STANDARD', null, true],
      ]);
      expect(await layoutViolations(room.id)).toEqual([]);
    });

    it('rejects a seat in two pairs, a pair missing one side, and coupleWith on itself', async () => {
      const room = await createRoom(1, 4);
      const id = idsOf(room);

      const overlap = await patchSeats(room.id, [
        { seatId: id.get('A1')!, type: 'COUPLE', coupleWith: id.get('A2')! },
        { seatId: id.get('A2')!, type: 'COUPLE' },
        { seatId: id.get('A3')!, type: 'COUPLE', coupleWith: id.get('A2')! },
      ]);
      expect(violationsOf(overlap)).toEqual([
        { reason: 'OVERLAPPING_PAIRS', seats: ['A2', 'A1', 'A3'] },
      ]);

      const missing = await patchSeats(room.id, [
        { seatId: id.get('A1')!, type: 'COUPLE', coupleWith: id.get('A2')! },
      ]);
      expect(violationsOf(missing)).toEqual([{ reason: 'NOT_COUPLE_TYPE', seats: ['A1', 'A2'] }]);

      const self = await patchSeats(room.id, [
        { seatId: id.get('A1')!, coupleWith: id.get('A1')! },
      ]);
      expect(violationsOf(self)).toEqual([{ reason: 'SELF_PAIR', seats: ['A1'] }]);
      expect(await layoutViolations(room.id)).toEqual([]);
    });

    it('400 for more than 500 changes or a repeated seat', async () => {
      const room = await createRoom(1, 2);
      const tooMany = Array.from({ length: 501 }, (_, i) => ({
        seatId: `01a17e75-0000-7000-8000-${String(i).padStart(12, '0')}`,
      }));

      expect((await patchSeats(room.id, tooMany)).status).toBe(400);
      const repeated = await patchSeats(room.id, [
        { seatId: room.seats[0]!.id, type: 'VIP' },
        { seatId: room.seats[0]!.id, type: 'STANDARD' },
      ]);
      expect(repeated.status).toBe(400);
    });
  });

  // ─── Layout lock ───

  describe('layout lock while showtimes are upcoming', () => {
    it('upcoming showtime → 409 ROOM_IN_USE on seat edits, renaming still works', async () => {
      const room = await createRoom(2, 2);
      await showtimeIn(room.id, '2026-11-01T09:00:00Z', '2026-11-01T11:00:00Z'); // running now
      await showtimeIn(room.id, '2026-11-02T13:00:00Z', '2026-11-02T15:00:00Z'); // tomorrow
      const before = await seatRows(room.id);

      const res = await patchSeats(room.id, [{ seatId: room.seats[0]!.id, type: 'VIP' }]);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ROOM_IN_USE',
        details: { activeShowtimeCount: 2, until: '2026-11-02T15:00:00.000Z' },
      });
      expect(await seatRows(room.id)).toEqual(before);

      const detail = bodyOf<AdminRoom>(await admin('get', `/admin/rooms/${room.id}`));
      expect(detail.lock).toEqual<RoomLock>({
        activeShowtimeCount: 2,
        until: '2026-11-02T15:00:00.000Z',
      });

      const renamed = await admin('patch', `/admin/rooms/${room.id}`, { name: 'Phòng đang chiếu' });
      expect(renamed.status).toBe(200);
      expect(bodyOf<AdminRoom>(renamed).name).toBe('Phòng đang chiếu');
    });

    it('finished or cancelled showtimes do not lock; the lock lifts when the last one ends', async () => {
      const room = await createRoom(1, 2);
      await showtimeIn(room.id, '2026-11-01T06:00:00Z', '2026-11-01T08:00:00Z'); // ended
      await showtimeIn(room.id, '2026-11-01T12:00:00Z', '2026-11-01T14:00:00Z', true); // cancelled
      const seatId = room.seats[0]!.id;

      expect((await patchSeats(room.id, [{ seatId, type: 'VIP' }])).status).toBe(200);

      await showtimeIn(room.id, '2026-11-01T18:00:00Z', '2026-11-01T20:00:00Z');
      expect((await patchSeats(room.id, [{ seatId, type: 'STANDARD' }])).status).toBe(409);

      clock.set('2026-11-01T20:00:00.000Z'); // ends_at is exclusive: ended now
      // The 15-minute access token from NOW has expired; sign a new one at the new time.
      const token = await accessTokenFor(app, db.prisma, Role.ADMIN);
      const res = await as(token, 'patch', `/admin/rooms/${room.id}/seats`, {
        changes: [{ seatId, type: 'STANDARD' }],
      });
      expect(res.status).toBe(200);
      expect(bodyOf<AdminRoom>(res).lock).toBeNull();
    });
  });

  // ─── Concurrency ───

  describe('concurrent batches on one room', () => {
    const ROWS = 'ABCD';
    const COLS = 8;

    /** A plausible editor batch computed from a (possibly stale) snapshot of the room. */
    function randomBatch(seats: AdminSeat[], next: () => number): SeatChange[] {
      const at = (row: string, number: number) =>
        seats.find((s) => s.row === row && s.number === number)!;
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const changes = new Map<string, SeatChange>();
      const put = (change: SeatChange) =>
        changes.set(change.seatId, { ...changes.get(change.seatId), ...change });
      const partnerOf = (seat: AdminSeat) =>
        seat.coupleGroup === null
          ? undefined
          : seats.find((s) => s.coupleGroup === seat.coupleGroup && s.id !== seat.id);

      for (let i = 0; i < 4; i++) {
        const row = pick([...ROWS]);
        const number = 1 + Math.floor(next() * (COLS - 1));
        const left = at(row, number);
        const right = at(row, number + 1);
        switch (pick(['pair', 'vip', 'toggle', 'split'] as const)) {
          case 'pair':
            put({ seatId: left.id, type: 'COUPLE', isActive: true, coupleWith: right.id });
            put({ seatId: right.id, type: 'COUPLE', isActive: true });
            break;
          case 'vip':
            put({ seatId: left.id, type: 'VIP' });
            break;
          case 'toggle': {
            const partner = partnerOf(left);
            put({ seatId: left.id, isActive: !left.isActive });
            if (partner) put({ seatId: partner.id, isActive: !left.isActive });
            break;
          }
          case 'split': {
            const partner = partnerOf(left);
            put({ seatId: left.id, type: 'STANDARD', coupleWith: null });
            if (partner) put({ seatId: partner.id, type: 'STANDARD', coupleWith: null });
            break;
          }
        }
      }
      return [...changes.values()];
    }

    it('10 simultaneous batches: no 5xx, and every round ends in a valid layout', async () => {
      const room = await createRoom(ROWS.length, COLS);
      const next = random(20_261_101);
      const statuses = new Map<number, number>();

      for (let round = 0; round < 5; round++) {
        const snapshot = bodyOf<AdminRoom>(await admin('get', `/admin/rooms/${room.id}`)).seats;
        const batches = Array.from({ length: 10 }, () => randomBatch(snapshot, next));

        const responses = await Promise.all(batches.map((batch) => patchSeats(room.id, batch)));

        for (const res of responses) {
          statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
          expect([200, 422]).toContain(res.status);
        }
        expect(await layoutViolations(room.id)).toEqual([]);
      }
      // Sanity: the rounds really mixed successes and refusals.
      expect(statuses.get(200) ?? 0).toBeGreaterThan(0);
      expect(statuses.get(422) ?? 0).toBeGreaterThan(0);
    });
  });
});
