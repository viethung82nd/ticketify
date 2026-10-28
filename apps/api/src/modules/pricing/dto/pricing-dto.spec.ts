import { holidayRequestSchema, PRICING_LIMITS, seatPriceRequestSchema } from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { HolidayDto, ListHolidaysQueryDto, SeatPriceDto } from './pricing.dto';

type DtoClass<T> = new () => T;

/** Same options as the global ValidationPipe. */
function check<T extends object>(cls: DtoClass<T>, plain: object) {
  const instance = plainToInstance(cls, plain);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, invalid: errors.map((error) => error.property) };
}

describe('seat price', () => {
  it.each([PRICING_LIMITS.priceMin, 90_000, PRICING_LIMITS.priceMax])('accepts %d VND', (price) => {
    expect(check(SeatPriceDto, { price }).invalid).toEqual([]);
    expect(seatPriceRequestSchema.safeParse({ price }).success).toBe(true);
  });

  it.each([PRICING_LIMITS.priceMin - 1, PRICING_LIMITS.priceMax + 1, 0, -90_000])(
    '%d VND is out of range: 400 (and refused by the web form)',
    (price) => {
      expect(check(SeatPriceDto, { price }).invalid).toEqual(['price']);
      expect(seatPriceRequestSchema.safeParse({ price }).success).toBe(false);
    },
  );

  it.each([90_000.5, '90000', null, undefined])('%p is not an integer: 400', (price) => {
    expect(check(SeatPriceDto, { price }).invalid).toEqual(['price']);
    expect(seatPriceRequestSchema.safeParse({ price }).success).toBe(false);
  });
});

describe('holiday date', () => {
  it.each(['2026-09-02', '2000-01-01', '2100-12-31', '2028-02-29'])('accepts %s', (date) => {
    expect(check(HolidayDto, { date }).invalid).toEqual([]);
    expect(holidayRequestSchema.safeParse({ date }).success).toBe(true);
  });

  it.each([
    '2026-9-2',
    '02/09/2026',
    '2026-02-30',
    '2027-02-29',
    '2026-09-02T00:00:00Z',
    '1999-12-31',
    '2101-01-01',
    '',
  ])('rejects %p', (date) => {
    expect(check(HolidayDto, { date }).invalid).toEqual(['date']);
    expect(holidayRequestSchema.safeParse({ date }).success).toBe(false);
  });

  it('?year= is optional, numeric and within the managed range', () => {
    expect(check(ListHolidaysQueryDto, {}).invalid).toEqual([]);
    expect(check(ListHolidaysQueryDto, { year: '2026' }).instance.year).toBe(2026);
    for (const year of ['abc', '1999', '2101', '2026.5']) {
      expect(check(ListHolidaysQueryDto, { year }).invalid).toEqual(['year']);
    }
  });
});
