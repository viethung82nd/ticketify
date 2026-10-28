import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DayType,
  type FieldError,
  type Holiday,
  Role,
  type SeatPrice,
  SeatType,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { asyncHttpErrorOf } from '../../src/common/errors/testing/http-error';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { PricingService } from '../../src/modules/pricing/pricing.service';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

type Method = 'get' | 'post' | 'put' | 'delete';

const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';
/** 10:00 Monday 2026-11-02 in Vietnam: the "current year" for holidays is 2026. */
const NOW = '2026-11-02T03:00:00.000Z';

/** Same table as the development seed (prisma/seed/data.ts). */
const SEED_PRICES: Record<SeatType, Record<DayType, number>> = {
  STANDARD: { WEEKDAY: 75_000, WEEKEND: 90_000, HOLIDAY: 110_000 },
  VIP: { WEEKDAY: 95_000, WEEKEND: 115_000, HOLIDAY: 135_000 },
  COUPLE: { WEEKDAY: 100_000, WEEKEND: 120_000, HOLIDAY: 145_000 },
};

const instant = (iso: string): Date => new FakeClock(iso).now();

describe('Seat prices, holidays and day types (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let pricing: PricingService;
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
    await app.init();
    pricing = app.get(PricingService);
    [adminToken, userToken] = await Promise.all([
      accessTokenFor(app, db.prisma, Role.ADMIN),
      accessTokenFor(app, db.prisma, Role.USER),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  /** The 9 rows the seed creates; reset before each test. */
  beforeEach(async () => {
    await db.prisma.seatPrice.deleteMany();
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({
          seatType,
          dayType,
          price: SEED_PRICES[seatType][dayType],
        })),
      ),
    });
    await db.prisma.holiday.deleteMany();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string | undefined, method: Method, path: string, body?: object) => {
    const req = http()[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const admin = (method: Method, path: string, body?: object) => as(adminToken, method, path, body);

  async function addHoliday(date: string): Promise<Holiday> {
    const res = await admin('post', '/admin/holidays', { date });
    expect(res.status).toBe(201);
    return bodyOf<Holiday>(res);
  }

  const holidayDates = async (query = '') =>
    bodyOf<Holiday[]>(await admin('get', `/admin/holidays${query}`)).map((h) => h.date);

  // ─── Access control ───

  describe('role access', () => {
    const routes: [Method, string, object | undefined][] = [
      ['get', '/admin/seat-prices', undefined],
      ['put', '/admin/seat-prices/VIP/WEEKEND', { price: 100_000 }],
      ['get', '/admin/holidays?year=2026', undefined],
      ['post', '/admin/holidays', { date: '2026-09-02' }],
      ['delete', `/admin/holidays/${UNKNOWN_ID}`, undefined],
    ];

    it.each(routes)('%s %s: 401 without a token, 403 for USER', async (method, path, body) => {
      expect((await as(undefined, method, path, body)).status).toBe(401);

      const user = await as(userToken, method, path, body);
      expect(user.status).toBe(403);
      expect(errorOf(user).code).toBe('FORBIDDEN');
    });
  });

  // ─── Seat prices ───

  describe('seat prices', () => {
    it('lists the 9 cells by seat type, then day type', async () => {
      const res = await admin('get', '/admin/seat-prices');

      expect(res.status).toBe(200);
      const cells = bodyOf<SeatPrice[]>(res);
      expect(cells.map((c) => `${c.seatType}/${c.dayType}=${c.price}`)).toEqual([
        'STANDARD/WEEKDAY=75000',
        'STANDARD/WEEKEND=90000',
        'STANDARD/HOLIDAY=110000',
        'VIP/WEEKDAY=95000',
        'VIP/WEEKEND=115000',
        'VIP/HOLIDAY=135000',
        'COUPLE/WEEKDAY=100000',
        'COUPLE/WEEKEND=120000',
        'COUPLE/HOLIDAY=145000',
      ]);
    });

    it('updates one cell and only that cell', async () => {
      const res = await admin('put', '/admin/seat-prices/VIP/WEEKEND', { price: 125_000 });

      expect(res.status).toBe(200);
      expect(bodyOf<SeatPrice>(res)).toMatchObject({
        seatType: 'VIP',
        dayType: 'WEEKEND',
        price: 125_000,
      });
      const rows = await db.prisma.seatPrice.findMany({ where: { price: 125_000 } });
      expect(rows.map((r) => `${r.seatType}/${r.dayType}`)).toEqual(['VIP/WEEKEND']);
      await expect(pricing.priceFor(SeatType.VIP, DayType.WEEKEND)).resolves.toBe(125_000);
    });

    it('404 PRICE_NOT_FOUND when the cell row does not exist', async () => {
      await db.prisma.seatPrice.delete({
        where: { seatType_dayType: { seatType: 'COUPLE', dayType: 'HOLIDAY' } },
      });

      const res = await admin('put', '/admin/seat-prices/COUPLE/HOLIDAY', { price: 150_000 });

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRICE_NOT_FOUND');
      expect(
        await asyncHttpErrorOf(pricing.priceFor(SeatType.COUPLE, DayType.HOLIDAY)),
      ).toMatchObject({ status: 404, code: 'PRICE_NOT_FOUND' });
    });

    it.each([999, 2_000_001, 0])('400 VALIDATION_FAILED for %d; unchanged', async (price) => {
      const res = await admin('put', '/admin/seat-prices/STANDARD/WEEKDAY', { price });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect((errorOf(res).details as FieldError[]).map((error) => error.field)).toEqual(['price']);
      await expect(pricing.priceFor(SeatType.STANDARD, DayType.WEEKDAY)).resolves.toBe(75_000);
    });

    it('accepts the bounds 1.000 and 2.000.000', async () => {
      for (const price of [1_000, 2_000_000]) {
        const res = await admin('put', '/admin/seat-prices/STANDARD/WEEKDAY', { price });
        expect(res.status).toBe(200);
      }
    });

    it('400 for a non-integer price or an unknown seat/day type', async () => {
      expect((await admin('put', '/admin/seat-prices/VIP/WEEKEND', { price: 1.5 })).status).toBe(
        400,
      );
      expect((await admin('put', '/admin/seat-prices/VIP/WEEKEND', { price: '9' })).status).toBe(
        400,
      );
      expect((await admin('put', '/admin/seat-prices/SOFA/WEEKEND', { price: 9_000 })).status).toBe(
        400,
      );
      expect((await admin('put', '/admin/seat-prices/VIP/MONDAY', { price: 9_000 })).status).toBe(
        400,
      );
    });
  });

  // ─── Holidays ───

  describe('holidays', () => {
    it('adds a holiday (201) and lists it', async () => {
      const holiday = await addHoliday('2026-09-02');

      expect(holiday).toEqual({ id: expect.any(String) as string, date: '2026-09-02' });
      expect(await holidayDates('?year=2026')).toEqual(['2026-09-02']);
    });

    it('409 HOLIDAY_EXISTS for a date that is already a holiday', async () => {
      await addHoliday('2026-04-30');

      const res = await admin('post', '/admin/holidays', { date: '2026-04-30' });

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'HOLIDAY_EXISTS', details: { field: 'date' } });
      expect(await db.prisma.holiday.count()).toBe(1);
    });

    it('filters by year (boundaries included) and sorts by date', async () => {
      for (const date of ['2027-01-01', '2026-12-31', '2026-01-01', '2026-09-02', '2025-12-31']) {
        await addHoliday(date);
      }

      expect(await holidayDates('?year=2026')).toEqual(['2026-01-01', '2026-09-02', '2026-12-31']);
      expect(await holidayDates('?year=2027')).toEqual(['2027-01-01']);
      expect(await holidayDates('?year=2030')).toEqual([]);
      // Without ?year: the current year in the cinema time zone (FakeClock: 2026).
      expect(await holidayDates()).toEqual(['2026-01-01', '2026-09-02', '2026-12-31']);
    });

    it('deletes a holiday (204); unknown id is 404 HOLIDAY_NOT_FOUND', async () => {
      const holiday = await addHoliday('2026-05-01');

      expect((await admin('delete', `/admin/holidays/${holiday.id}`)).status).toBe(204);
      expect(await holidayDates('?year=2026')).toEqual([]);

      const again = await admin('delete', `/admin/holidays/${holiday.id}`);
      expect(again.status).toBe(404);
      expect(errorOf(again).code).toBe('HOLIDAY_NOT_FOUND');
    });

    it('400 for a malformed date or year', async () => {
      for (const date of ['2026-02-30', '02/09/2026', '2026-09-02T00:00:00Z']) {
        const res = await admin('post', '/admin/holidays', { date });
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect((await admin('get', '/admin/holidays?year=abc')).status).toBe(400);
    });
  });

  // ─── Day type against the real Holiday table ───

  describe('PricingService.dayType with the Holiday table', () => {
    it('a Tuesday turns HOLIDAY once it is added, and back after deletion', async () => {
      const tuesdayEvening = instant('2026-11-03T13:00:00Z'); // 20:00 Tue in Vietnam

      await expect(pricing.dayType(tuesdayEvening)).resolves.toBe(DayType.WEEKDAY);
      const holiday = await addHoliday('2026-11-03');
      await expect(pricing.dayType(tuesdayEvening)).resolves.toBe(DayType.HOLIDAY);

      await admin('delete', `/admin/holidays/${holiday.id}`);
      await expect(pricing.dayType(tuesdayEvening)).resolves.toBe(DayType.WEEKDAY);
    });

    it('uses the Vietnamese date: 00:30 Tuesday local (17:30 Monday UTC) is the holiday', async () => {
      await addHoliday('2026-11-03');

      await expect(pricing.dayType(instant('2026-11-02T17:30:00Z'))).resolves.toBe(DayType.HOLIDAY);
      await expect(pricing.dayType(instant('2026-11-02T16:59:00Z'))).resolves.toBe(DayType.WEEKDAY);
    });

    it('a holiday on Saturday is HOLIDAY; Sunday 23:30 local stays WEEKEND', async () => {
      await addHoliday('2026-10-31');

      await expect(pricing.dayType(instant('2026-10-31T05:00:00Z'))).resolves.toBe(DayType.HOLIDAY);
      await expect(pricing.dayType(instant('2026-11-01T16:30:00Z'))).resolves.toBe(DayType.WEEKEND);
    });

    it('works inside a caller transaction (as showtime creation will)', async () => {
      await addHoliday('2026-12-25');

      const result = await db.prisma.$transaction((tx) =>
        pricing.dayType(instant('2026-12-25T10:00:00Z'), tx),
      );
      expect(result).toBe(DayType.HOLIDAY);
    });
  });
});
