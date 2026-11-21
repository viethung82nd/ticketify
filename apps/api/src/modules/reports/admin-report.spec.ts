import {
  ADMIN_REPORT_LIMITS,
  adminBookingsQuerySchema,
  daysInRange,
  occupancyQuerySchema,
  revenueQuerySchema,
} from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminBookingsQueryDto, OccupancyQueryDto, RevenueQueryDto } from './dto/admin-report.dto';

type DtoClass<T> = new () => T;

/** Same options as the global ValidationPipe; query values arrive as strings. */
function check<T extends object>(cls: DtoClass<T>, plain: object) {
  const instance = plainToInstance(cls, plain);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, invalid: errors.map((error) => error.property) };
}

describe('daysInRange', () => {
  it.each([
    ['2026-11-01', '2026-11-01', 1],
    ['2026-11-01', '2026-11-07', 7],
    ['2026-10-31', '2026-11-30', 31],
    ['2026-02-28', '2026-03-01', 2],
    ['2028-02-28', '2028-03-01', 3],
  ])('%s → %s is %i days, both included', (from, to, days) => {
    expect(daysInRange(from, to)).toBe(days);
  });
});

describe('AdminBookingsQueryDto (and the web schema, which must agree)', () => {
  it('accepts no filter at all', () => {
    expect(check(AdminBookingsQueryDto, {}).invalid).toEqual([]);
    expect(adminBookingsQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts every filter, page numbers as strings', () => {
    const query = {
      status: 'CONFIRMED',
      q: 'K7PX3MQ9TA',
      from: '2026-11-01',
      to: '2026-11-30',
      page: '2',
      pageSize: String(ADMIN_REPORT_LIMITS.listPageSizeMax),
    };
    const { instance, invalid } = check(AdminBookingsQueryDto, query);

    expect(invalid).toEqual([]);
    expect(instance).toMatchObject({ page: 2, pageSize: ADMIN_REPORT_LIMITS.listPageSizeMax });
    expect(adminBookingsQuerySchema.safeParse(query).success).toBe(true);
  });

  it('a blank search is no search', () => {
    expect(check(AdminBookingsQueryDto, { q: '   ' }).instance.q).toBeUndefined();
  });

  it.each([
    ['an unknown status', { status: 'PAID' }, 'status'],
    ['a search that is too long', { q: 'a'.repeat(ADMIN_REPORT_LIMITS.searchMax + 1) }, 'q'],
    ['a date that does not exist', { from: '2026-02-30' }, 'from'],
    ['a date-time instead of a date', { to: '2026-11-01T00:00:00Z' }, 'to'],
    ['page 0', { page: '0' }, 'page'],
    ['a page size above the maximum', { pageSize: '101' }, 'pageSize'],
  ])('rejects %s', (_label, query, field) => {
    expect(check(AdminBookingsQueryDto, query).invalid).toEqual([field]);
    expect(adminBookingsQuerySchema.safeParse(query).success).toBe(false);
  });

  it('from after to: the web schema refuses it; the API checks it in the service', () => {
    const query = { from: '2026-11-02', to: '2026-11-01' };

    expect(check(AdminBookingsQueryDto, query).invalid).toEqual([]);
    expect(adminBookingsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('RevenueQueryDto and OccupancyQueryDto (and the web schemas)', () => {
  it('accept no dates', () => {
    expect(check(RevenueQueryDto, {}).invalid).toEqual([]);
    expect(check(OccupancyQueryDto, {}).invalid).toEqual([]);
    expect(revenueQuerySchema.safeParse({}).success).toBe(true);
    expect(occupancyQuerySchema.safeParse({}).success).toBe(true);
  });

  it(`revenue: up to ${ADMIN_REPORT_LIMITS.revenueDaysMax} days, not one more (the service checks the API side)`, () => {
    expect(revenueQuerySchema.safeParse({ from: '2026-10-31', to: '2026-11-30' }).success).toBe(
      true,
    );
    expect(revenueQuerySchema.safeParse({ from: '2026-10-30', to: '2026-11-30' }).success).toBe(
      false,
    );
    expect(revenueQuerySchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success).toBe(
      false,
    );
  });

  it('reject malformed dates', () => {
    expect(check(RevenueQueryDto, { from: '01/11/2026' }).invalid).toEqual(['from']);
    expect(check(OccupancyQueryDto, { date: '2026-13-01' }).invalid).toEqual(['date']);
    expect(occupancyQuerySchema.safeParse({ date: '2026-13-01' }).success).toBe(false);
  });
});
