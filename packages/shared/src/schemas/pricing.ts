import { z } from 'zod';
import { DayType, SeatType } from '../enums.js';
import { isIsoDate } from './movie.js';

/** Limits shared by the API and the web forms so both validate the same way. */
export const PRICING_LIMITS = {
  /** VND per seat. */
  priceMin: 1_000,
  priceMax: 2_000_000,
  /** Holidays are managed for years in this range. */
  yearMin: 2000,
  yearMax: 2100,
} as const;

/** Display order of the price table: rows by seat type, columns by day type. */
export const SEAT_TYPE_ORDER: readonly SeatType[] = [
  SeatType.STANDARD,
  SeatType.VIP,
  SeatType.COUPLE,
];
export const DAY_TYPE_ORDER: readonly DayType[] = [
  DayType.WEEKDAY,
  DayType.WEEKEND,
  DayType.HOLIDAY,
];

/** `1500000` → `1.500.000` (Vietnamese thousands separator, no currency sign). */
export const formatVnd = (amount: number): string =>
  Math.trunc(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const priceRangeMessage = `Giá từ ${formatVnd(PRICING_LIMITS.priceMin)} ₫ đến ${formatVnd(PRICING_LIMITS.priceMax)} ₫`;

// ─── Requests ───

/**
 * `PUT /admin/seat-prices/:seatType/:dayType`. The API refuses a non-integer or out-of-range
 * price with `400 VALIDATION_FAILED` (value limits are format rules, see CONTRIBUTING.md).
 */
export const seatPriceRequestSchema = z.object({
  price: z
    .number({ error: 'Vui lòng nhập giá' })
    .int({ error: 'Giá phải là số nguyên (VND)' })
    .min(PRICING_LIMITS.priceMin, { error: priceRangeMessage })
    .max(PRICING_LIMITS.priceMax, { error: priceRangeMessage }),
});
export type SeatPriceRequest = z.infer<typeof seatPriceRequestSchema>;

/** `YYYY-MM-DD` naming a real day in a year the app manages holidays for. */
export const isHolidayDate = (value: string): boolean => {
  if (!isIsoDate(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= PRICING_LIMITS.yearMin && year <= PRICING_LIMITS.yearMax;
};

/** `POST /admin/holidays`: a calendar date in the cinema time zone. */
export const holidayRequestSchema = z.object({
  date: z.string({ error: 'Vui lòng chọn ngày' }).refine(isHolidayDate, {
    error: `Ngày phải có dạng YYYY-MM-DD, năm từ ${PRICING_LIMITS.yearMin} đến ${PRICING_LIMITS.yearMax}`,
  }),
});
export type HolidayRequest = z.infer<typeof holidayRequestSchema>;

// ─── Responses ───

export const seatPriceSchema = z.object({
  seatType: z.enum(SeatType),
  dayType: z.enum(DayType),
  /** VND per seat. */
  price: z.number().int(),
  updatedAt: z.string(),
});
export type SeatPrice = z.infer<typeof seatPriceSchema>;

export const holidaySchema = z.object({
  id: z.uuid(),
  /** `YYYY-MM-DD`. */
  date: z.string(),
});
export type Holiday = z.infer<typeof holidaySchema>;

/** Machine-readable `code` values of pricing API errors. */
export const PricingErrorCode = {
  PRICE_NOT_FOUND: 'PRICE_NOT_FOUND',
  HOLIDAY_EXISTS: 'HOLIDAY_EXISTS',
  HOLIDAY_NOT_FOUND: 'HOLIDAY_NOT_FOUND',
} as const;
export type PricingErrorCode = (typeof PricingErrorCode)[keyof typeof PricingErrorCode];
