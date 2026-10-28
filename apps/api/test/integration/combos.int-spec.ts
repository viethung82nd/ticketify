import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminCombo,
  type Combo,
  COMBO_LIMITS,
  type FieldError,
  Role,
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
const NOW = '2026-11-01T10:00:00.000Z';

describe('Combos (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let fixtures: Fixtures;
  let app: INestApplication<App>;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(new FakeClock(NOW))
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
    await db.prisma.bookingCombo.deleteMany();
    await db.prisma.combo.deleteMany();
  });

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const as = (token: string | undefined, method: Method, path: string, body?: object) => {
    const req = http()[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const admin = (method: Method, path: string, body?: object) => as(adminToken, method, path, body);

  async function createCombo(body: object): Promise<AdminCombo> {
    const res = await admin('post', '/admin/combos', body);
    expect(res.status).toBe(201);
    return bodyOf<AdminCombo>(res);
  }

  /** A booking line for `combo`, with the snapshot phase 2 will write. */
  async function bookCombo(combo: AdminCombo, quantity = 2) {
    const [user, movie, room] = await Promise.all([
      fixtures.user(),
      fixtures.movie(),
      fixtures.room(),
    ]);
    const showtime = await fixtures.showtime({
      movieId: movie.id,
      roomId: room.id,
      startsAt: '2026-11-02T12:00:00Z',
      endsAt: '2026-11-02T14:00:00Z',
    });
    const booking = await fixtures.booking(user.id, showtime.id);
    return db.prisma.bookingCombo.create({
      data: {
        bookingId: booking.id,
        comboId: combo.id,
        comboName: combo.name,
        unitPrice: combo.price,
        quantity,
      },
    });
  }

  // ─── Access control ───

  describe('role access', () => {
    const routes: [Method, string, object | undefined][] = [
      ['get', '/admin/combos', undefined],
      ['post', '/admin/combos', { name: 'X', price: 50_000 }],
      ['patch', `/admin/combos/${UNKNOWN_ID}`, { price: 50_000 }],
      ['delete', `/admin/combos/${UNKNOWN_ID}`, undefined],
    ];

    it.each(routes)('%s %s: 401 without a token, 403 for USER', async (method, path, body) => {
      expect((await as(undefined, method, path, body)).status).toBe(401);

      const user = await as(userToken, method, path, body);
      expect(user.status).toBe(403);
      expect(errorOf(user).code).toBe('FORBIDDEN');
    });

    it('GET /combos is public', async () => {
      expect((await http().get('/combos')).status).toBe(200);
    });
  });

  // ─── CRUD ───

  describe('CRUD', () => {
    it('creates a combo (201), active by default, blank description stored as null', async () => {
      const combo = await createCombo({
        name: '  Combo bắp nước ',
        description: '   ',
        price: 89_000,
      });

      expect(combo).toMatchObject({
        name: 'Combo bắp nước',
        description: null,
        price: 89_000,
        isActive: true,
        bookingCount: 0,
      });
    });

    it('lists by Vietnamese name order; the public list shows active combos only', async () => {
      await createCombo({ name: 'Đồ uống lớn', price: 40_000 });
      await createCombo({ name: 'Dừa tươi', price: 35_000 });
      await createCombo({ name: 'Bắp rang', price: 50_000 });
      const hidden = await createCombo({ name: 'Combo cũ', price: 60_000, isActive: false });

      const all = bodyOf<AdminCombo[]>(await admin('get', '/admin/combos'));
      expect(all.map((c) => c.name)).toEqual(['Bắp rang', 'Combo cũ', 'Dừa tươi', 'Đồ uống lớn']);

      const visible = bodyOf<Combo[]>(await http().get('/combos'));
      expect(visible.map((c) => c.name)).toEqual(['Bắp rang', 'Dừa tươi', 'Đồ uống lớn']);
      // Public view: no admin fields (isActive, bookingCount, timestamps).
      expect(Object.keys(visible[0]!).sort()).toEqual(['description', 'id', 'name', 'price']);
      expect(visible[0]).toMatchObject({ name: 'Bắp rang', description: null, price: 50_000 });

      // Switching it back on makes it public again.
      const on = await admin('patch', `/admin/combos/${hidden.id}`, { isActive: true });
      expect(on.status).toBe(200);
      expect(bodyOf<Combo[]>(await http().get('/combos'))).toHaveLength(4);
    });

    it.each([
      ['BẮP RANG BƠ'],
      ['bap rang bo'],
      ['  Bắp   rang bơ '],
      ['Bắp rang bơ'.normalize('NFD')],
    ])('409 COMBO_NAME_TAKEN for %p next to "Bắp rang bơ"', async (name) => {
      await createCombo({ name: 'Bắp rang bơ', price: 50_000 });

      const res = await admin('post', '/admin/combos', { name, price: 60_000 });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('COMBO_NAME_TAKEN');
      expect(errorOf(res).details).toEqual({ field: 'name' });
      expect(await db.prisma.combo.count()).toBe(1);
    });

    it('renaming to another combo’s name is 409; to a variant of its own name is fine', async () => {
      const a = await createCombo({ name: 'Combo đôi', price: 99_000 });
      await createCombo({ name: 'Combo đơn', price: 59_000 });

      const clash = await admin('patch', `/admin/combos/${a.id}`, { name: 'COMBO DON' });
      expect(clash.status).toBe(409);
      expect(errorOf(clash).code).toBe('COMBO_NAME_TAKEN');

      const own = await admin('patch', `/admin/combos/${a.id}`, { name: 'COMBO ĐÔI' });
      expect(own.status).toBe(200);
      expect(bodyOf<AdminCombo>(own).name).toBe('COMBO ĐÔI');
    });

    it.each([
      ['price below the minimum', { name: 'A', price: COMBO_LIMITS.priceMin - 1 }, 'price'],
      ['price above the maximum', { name: 'A', price: COMBO_LIMITS.priceMax + 1 }, 'price'],
      ['a non-integer price', { name: 'A', price: 50_000.5 }, 'price'],
      ['an empty name', { name: ' ', price: 50_000 }, 'name'],
      ['a name over 100 characters', { name: 'x'.repeat(101), price: 50_000 }, 'name'],
    ])('400 VALIDATION_FAILED for %s', async (_label, body, field) => {
      const res = await admin('post', '/admin/combos', body);

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect((errorOf(res).details as FieldError[]).map((d) => d.field)).toEqual([field]);
    });

    it('PATCH outside the price range is 400; unknown ids are 404', async () => {
      const combo = await createCombo({ name: 'A', price: 50_000 });

      const res = await admin('patch', `/admin/combos/${combo.id}`, { price: 500_001 });
      expect(res.status).toBe(400);

      const missing = await admin('patch', `/admin/combos/${UNKNOWN_ID}`, { price: 50_000 });
      expect(missing.status).toBe(404);
      expect(errorOf(missing).code).toBe('COMBO_NOT_FOUND');
      expect((await admin('delete', `/admin/combos/${UNKNOWN_ID}`)).status).toBe(404);
    });

    it('deletes an unused combo (204)', async () => {
      const combo = await createCombo({ name: 'A', price: 50_000 });

      expect((await admin('delete', `/admin/combos/${combo.id}`)).status).toBe(204);
      expect(await db.prisma.combo.count()).toBe(0);
    });

    it('409 COMBO_IN_USE when a booking references it; switching it off still works', async () => {
      const combo = await createCombo({ name: 'Combo bắp nước', price: 89_000 });
      await bookCombo(combo);

      const res = await admin('delete', `/admin/combos/${combo.id}`);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('COMBO_IN_USE');
      expect(errorOf(res).details).toEqual({ bookingCount: 1 });
      expect(await db.prisma.combo.count()).toBe(1);

      const off = await admin('patch', `/admin/combos/${combo.id}`, { isActive: false });
      expect(off.status).toBe(200);
      expect(bodyOf<AdminCombo>(off)).toMatchObject({ isActive: false, bookingCount: 1 });
    });

    it('a booking keeps its combo name and price after the combo is edited', async () => {
      const combo = await createCombo({ name: 'Combo bắp nước', price: 89_000 });
      const line = await bookCombo(combo, 3);

      const res = await admin('patch', `/admin/combos/${combo.id}`, {
        name: 'Combo bắp nước lớn',
        price: 109_000,
        isActive: false,
      });
      expect(res.status).toBe(200);

      const after = await db.prisma.bookingCombo.findUniqueOrThrow({ where: { id: line.id } });
      expect(after).toMatchObject({
        comboId: combo.id,
        comboName: 'Combo bắp nước',
        unitPrice: 89_000,
        quantity: 3,
      });
    });
  });

  // ─── Concurrency ───

  it('10 simultaneous creates of names that differ only by case/diacritics: one 201, nine 409', async () => {
    const names = [
      'Bắp rang bơ',
      'bắp rang bơ',
      'BẮP RANG BƠ',
      'bap rang bo',
      'BAP RANG BO',
      'Bap Rang Bo',
      'Bắp Rang Bơ',
      'bắp  rang bơ',
      'Bắp rang bơ'.normalize('NFD'),
      'bap rang bơ',
    ];

    const responses = await Promise.all(
      names.map((name) => admin('post', '/admin/combos', { name, price: 50_000 })),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([201, ...Array<number>(9).fill(409)]);
    expect(await db.prisma.combo.count()).toBe(1);
  });
});
