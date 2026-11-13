import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminVoucher,
  type FieldError,
  Role,
  VoucherErrorCode,
  type VoucherUsageStatus,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { appTestEnv } from '../../support/app-env';
import { accessTokenFor } from '../../support/auth';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { createFixtures, type Fixtures } from '../../support/fixtures';
import { bodyOf, errorOf } from '../../support/http';
import { createTestRedis, type TestRedis } from '../../support/redis';

type Method = 'get' | 'post' | 'patch' | 'delete';

const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';
const NOW = '2026-11-13T10:00:00.000Z';

/** The smallest valid create body. */
const VOUCHER = {
  code: 'SUMMER10',
  discountType: 'PERCENT',
  discountValue: 10,
  startsAt: '2026-12-01T00:00:00+07:00',
  endsAt: '2027-01-01T00:00:00+07:00',
} as const;

describe('Vouchers, admin CRUD (real Postgres + Redis, ROADMAP 5.1)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let fixtures: Fixtures;
  let app: INestApplication<App>;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    const { AppModule } = await import('../../../src/app.module.js');
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
    await db.prisma.voucherUsage.deleteMany();
    await db.prisma.voucher.deleteMany();
  });

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const as = (token: string | undefined, method: Method, path: string, body?: object) => {
    const req = http()[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const admin = (method: Method, path: string, body?: object) => as(adminToken, method, path, body);

  async function createVoucher(body: object = VOUCHER): Promise<AdminVoucher> {
    const res = await admin('post', '/admin/vouchers', body);
    expect(res.status).toBe(201);
    return bodyOf<AdminVoucher>(res);
  }

  /** Fields named by a 400 VALIDATION_FAILED. */
  const invalidFields = (res: request.Response) => {
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe('VALIDATION_FAILED');
    return (error.details as FieldError[]).map((detail) => detail.field).sort();
  };

  /** A booking that used `voucher`, as 5.2 will record it. */
  async function useVoucher(voucher: AdminVoucher, status: VoucherUsageStatus = 'CONSUMED') {
    const [user, movie, room] = await Promise.all([
      fixtures.user(),
      fixtures.movie(),
      fixtures.room(),
    ]);
    const showtime = await fixtures.showtime({
      movieId: movie.id,
      roomId: room.id,
      startsAt: '2026-12-02T12:00:00Z',
      endsAt: '2026-12-02T14:00:00Z',
    });
    const booking = await fixtures.booking(user.id, showtime.id);
    return db.prisma.voucherUsage.create({
      data: { voucherId: voucher.id, userId: user.id, bookingId: booking.id, status },
    });
  }

  // ─── Access control ───

  describe('role access', () => {
    const routes: [Method, string, object | undefined][] = [
      ['get', '/admin/vouchers', undefined],
      ['get', `/admin/vouchers/${UNKNOWN_ID}`, undefined],
      ['post', '/admin/vouchers', VOUCHER],
      ['patch', `/admin/vouchers/${UNKNOWN_ID}`, { isActive: false }],
      ['delete', `/admin/vouchers/${UNKNOWN_ID}`, undefined],
    ];

    it.each(routes)('%s %s: 401 without a token, 403 for USER', async (method, path, body) => {
      expect((await as(undefined, method, path, body)).status).toBe(401);

      const user = await as(userToken, method, path, body);
      expect(user.status).toBe(403);
      expect(errorOf(user).code).toBe('FORBIDDEN');
    });
  });

  // ─── Create ───

  describe('POST /admin/vouchers', () => {
    it('201 with the code upper-cased, the defaults filled in and no usage', async () => {
      const voucher = await createVoucher({ ...VOUCHER, code: ' summer10 ', description: '  ' });

      expect(voucher).toMatchObject({
        code: 'SUMMER10',
        description: null,
        discountType: 'PERCENT',
        discountValue: 10,
        maxDiscount: null,
        minSubtotal: 0,
        usageLimit: null,
        perUserLimit: 1,
        startsAt: '2026-11-30T17:00:00.000Z',
        endsAt: '2026-12-31T17:00:00.000Z',
        isActive: true,
        usage: { reserved: 0, consumed: 0, released: 0 },
      });
      expect(await db.prisma.voucher.count()).toBe(1);
    });

    it('stores every field it is given; perUserLimit null means unlimited', async () => {
      const voucher = await createVoucher({
        ...VOUCHER,
        code: 'TET2027',
        description: 'Tết',
        discountValue: 20,
        maxDiscount: 50_000,
        minSubtotal: 150_000,
        usageLimit: 500,
        perUserLimit: null,
        isActive: false,
      });

      expect(voucher).toMatchObject({
        description: 'Tết',
        maxDiscount: 50_000,
        minSubtotal: 150_000,
        usageLimit: 500,
        perUserLimit: null,
        isActive: false,
      });
    });

    it.each([
      [
        'FIXED below the minimum amount',
        { discountType: 'FIXED', discountValue: 50 },
        ['discountValue'],
      ],
      ['PERCENT above 100', { discountValue: 150 }, ['discountValue']],
      [
        'FIXED with a cap',
        { discountType: 'FIXED', discountValue: 20_000, maxDiscount: 5_000 },
        ['maxDiscount'],
      ],
      ['an end before the start', { endsAt: '2026-11-01T00:00:00+07:00' }, ['endsAt']],
      ['a malformed code', { code: 'SUMMER-10' }, ['code']],
      ['a date without offset', { startsAt: '2026-12-01T00:00:00' }, ['startsAt']],
    ])('400 VALIDATION_FAILED for %s, nothing written', async (_label, change, fields) => {
      expect(
        invalidFields(await admin('post', '/admin/vouchers', { ...VOUCHER, ...change })),
      ).toEqual(fields);
      expect(await db.prisma.voucher.count()).toBe(0);
    });

    it('409 VOUCHER_CODE_TAKEN for a code that differs only by case', async () => {
      await createVoucher();

      const res = await admin('post', '/admin/vouchers', { ...VOUCHER, code: 'summer10' });

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: VoucherErrorCode.VOUCHER_CODE_TAKEN,
        details: { field: 'code' },
      });
    });
  });

  // ─── Read ───

  describe('GET', () => {
    it('lists newest first, with uses counted per status', async () => {
      const older = await createVoucher({ ...VOUCHER, code: 'OLDER1' });
      const newer = await createVoucher({ ...VOUCHER, code: 'NEWER1' });
      await Promise.all([
        useVoucher(older, 'RESERVED'),
        useVoucher(older, 'CONSUMED'),
        useVoucher(older, 'CONSUMED'),
        useVoucher(older, 'RELEASED'),
      ]);

      const res = await admin('get', '/admin/vouchers');

      expect(res.status).toBe(200);
      expect(bodyOf<AdminVoucher[]>(res).map(({ code, usage }) => ({ code, usage }))).toEqual([
        { code: newer.code, usage: { reserved: 0, consumed: 0, released: 0 } },
        { code: older.code, usage: { reserved: 1, consumed: 2, released: 1 } },
      ]);
    });

    it('reads one voucher; 404 for an unknown id, 400 for a malformed one', async () => {
      const voucher = await createVoucher();
      await useVoucher(voucher, 'RESERVED');

      const res = await admin('get', `/admin/vouchers/${voucher.id}`);
      expect(res.status).toBe(200);
      expect(bodyOf<AdminVoucher>(res)).toMatchObject({
        id: voucher.id,
        usage: { reserved: 1, consumed: 0, released: 0 },
      });

      const unknown = await admin('get', `/admin/vouchers/${UNKNOWN_ID}`);
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe(VoucherErrorCode.VOUCHER_NOT_FOUND);
      expect((await admin('get', '/admin/vouchers/not-a-uuid')).status).toBe(400);
    });
  });

  // ─── Update ───

  describe('PATCH /admin/vouchers/:id', () => {
    it('changes only the fields sent', async () => {
      const voucher = await createVoucher({ ...VOUCHER, maxDiscount: 30_000, usageLimit: 100 });

      const res = await admin('patch', `/admin/vouchers/${voucher.id}`, {
        description: 'Khuyến mãi hè',
        usageLimit: null,
        isActive: false,
      });

      expect(res.status).toBe(200);
      expect(bodyOf<AdminVoucher>(res)).toMatchObject({
        code: 'SUMMER10',
        description: 'Khuyến mãi hè',
        discountValue: 10,
        maxDiscount: 30_000,
        usageLimit: null,
        startsAt: voucher.startsAt,
        endsAt: voucher.endsAt,
        isActive: false,
      });
    });

    it('checks the rules across fields on the voucher as it would be stored', async () => {
      const voucher = await createVoucher({ ...VOUCHER, discountValue: 50, maxDiscount: 30_000 });
      const patch = (body: object) => admin('patch', `/admin/vouchers/${voucher.id}`, body);

      // Switching the type keeps the stored 50 (too small in VND) and the stored cap.
      expect(invalidFields(await patch({ discountType: 'FIXED' }))).toEqual([
        'discountValue',
        'maxDiscount',
      ]);
      // An end before the stored start.
      expect(invalidFields(await patch({ endsAt: '2026-11-30T00:00:00+07:00' }))).toEqual([
        'endsAt',
      ]);
      // Nothing was written by the refusals.
      expect(
        await db.prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } }),
      ).toMatchObject({ discountType: 'PERCENT', discountValue: 50, maxDiscount: 30_000 });

      const fixed = await patch({
        discountType: 'FIXED',
        discountValue: 20_000,
        maxDiscount: null,
      });
      expect(fixed.status).toBe(200);
      expect(bodyOf<AdminVoucher>(fixed)).toMatchObject({
        discountType: 'FIXED',
        discountValue: 20_000,
        maxDiscount: null,
      });
    });

    it('renames an unused voucher; 409 VOUCHER_CODE_TAKEN for another voucher’s code', async () => {
      const voucher = await createVoucher();
      await createVoucher({ ...VOUCHER, code: 'TAKEN1' });

      const renamed = await admin('patch', `/admin/vouchers/${voucher.id}`, { code: 'winter10' });
      expect(renamed.status).toBe(200);
      expect(bodyOf<AdminVoucher>(renamed).code).toBe('WINTER10');

      const taken = await admin('patch', `/admin/vouchers/${voucher.id}`, { code: 'taken1' });
      expect(taken.status).toBe(409);
      expect(errorOf(taken).code).toBe(VoucherErrorCode.VOUCHER_CODE_TAKEN);
    });

    it('409 VOUCHER_IN_USE when changing the code of a used voucher; other edits still work', async () => {
      const voucher = await createVoucher();
      await useVoucher(voucher, 'RELEASED');
      const patch = (body: object) => admin('patch', `/admin/vouchers/${voucher.id}`, body);

      const renamed = await patch({ code: 'OTHER10' });
      expect(renamed.status).toBe(409);
      expect(errorOf(renamed)).toMatchObject({
        code: VoucherErrorCode.VOUCHER_IN_USE,
        details: { usageCount: 1 },
      });

      // Sending the same code (in any case) is not a change.
      expect((await patch({ code: 'summer10', discountValue: 15 })).status).toBe(200);
      expect((await patch({ isActive: false })).status).toBe(200);
    });

    it('404 for an unknown id, 400 for null on a required field', async () => {
      const unknown = await admin('patch', `/admin/vouchers/${UNKNOWN_ID}`, { isActive: false });
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe(VoucherErrorCode.VOUCHER_NOT_FOUND);

      const voucher = await createVoucher();
      expect(
        invalidFields(await admin('patch', `/admin/vouchers/${voucher.id}`, { endsAt: null })),
      ).toEqual(['endsAt']);
    });
  });

  // ─── Delete ───

  describe('DELETE /admin/vouchers/:id', () => {
    it('deletes an unused voucher (204); 404 afterwards', async () => {
      const voucher = await createVoucher();

      expect((await admin('delete', `/admin/vouchers/${voucher.id}`)).status).toBe(204);
      expect(await db.prisma.voucher.count()).toBe(0);
      expect((await admin('delete', `/admin/vouchers/${voucher.id}`)).status).toBe(404);
    });

    it.each(['RESERVED', 'CONSUMED', 'RELEASED'] as const)(
      '409 VOUCHER_IN_USE once a booking used it (%s); switching it off still works',
      async (status) => {
        const voucher = await createVoucher();
        await useVoucher(voucher, status);

        const res = await admin('delete', `/admin/vouchers/${voucher.id}`);

        expect(res.status).toBe(409);
        expect(errorOf(res)).toMatchObject({
          code: VoucherErrorCode.VOUCHER_IN_USE,
          details: { usageCount: 1 },
        });
        expect(await db.prisma.voucher.count()).toBe(1);
        const off = await admin('patch', `/admin/vouchers/${voucher.id}`, { isActive: false });
        expect(off.status).toBe(200);
      },
    );
  });

  // ─── Concurrency ───

  it('10 simultaneous creates of one code in different cases: one 201, nine 409', async () => {
    const codes = [
      'summer10',
      'SUMMER10',
      'Summer10',
      'sUMMER10',
      ' summer10',
      'SUMMER10 ',
      'SuMmEr10',
      'summeR10',
      'SUmmer10',
      'sumMER10',
    ];

    const responses = await Promise.all(
      codes.map((code) => admin('post', '/admin/vouchers', { ...VOUCHER, code })),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([201, ...Array<number>(9).fill(409)]);
    expect(responses.filter((res) => res.status === 409).map((res) => errorOf(res).code)).toEqual(
      Array<string>(9).fill(VoucherErrorCode.VOUCHER_CODE_TAKEN),
    );
    expect(await db.prisma.voucher.count()).toBe(1);
  });
});
