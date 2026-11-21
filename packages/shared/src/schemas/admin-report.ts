import { z } from 'zod';
import { BookingStatus, PaymentStatus, ShowtimeStatus } from '../enums.js';
import { isIsoDate, pageSchema } from './movie.js';

/** Limits of the admin booking list and dashboard (ROADMAP 5.5). */
export const ADMIN_REPORT_LIMITS = {
  listPageSizeDefault: 20,
  listPageSizeMax: 100,
  /** Booking code or customer email, as typed. */
  searchMax: 100,
  /** Days of the revenue report: the last 7 cinema days by default, at most 31. */
  revenueDaysDefault: 7,
  revenueDaysMax: 31,
} as const;

/** `YYYY-MM-DD` on the cinema's calendar (CINEMA_TZ). */
export const cinemaDateSchema = z
  .string()
  .refine(isIsoDate, { error: 'Ngày phải có dạng YYYY-MM-DD' });

/** Whole days from `from` to `to`, both counted: `2026-11-01`..`2026-11-01` is 1. */
export function daysInRange(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

// ─── GET /admin/bookings ───

/**
 * Filters of the admin booking list, newest first. `from`/`to` are cinema days and match the day
 * the booking was **created** (held), both included. `q` matches the booking code exactly (any
 * letter case) or the customer's email by substring.
 */
export const adminBookingsQuerySchema = z
  .object({
    status: z.enum(BookingStatus).optional(),
    q: z.string().trim().min(1).max(ADMIN_REPORT_LIMITS.searchMax).optional(),
    from: cinemaDateSchema.optional(),
    to: cinemaDateSchema.optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(ADMIN_REPORT_LIMITS.listPageSizeMax).optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['to'],
    error: 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu',
  });
export type AdminBookingsQuery = z.input<typeof adminBookingsQuerySchema>;

/** One row of the admin booking list: enough to find a booking and answer a customer. */
export const adminBookingSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  status: z.enum(BookingStatus),
  subtotal: z.number().int(),
  discount: z.number().int(),
  total: z.number().int(),
  voucherCode: z.string().nullable(),
  createdAt: z.string(),
  /** PENDING: the last moment to start a payment. */
  expiresAt: z.string(),
  confirmedAt: z.string().nullable(),
  user: z.object({ id: z.uuid(), email: z.string(), fullName: z.string() }),
  showtime: z.object({
    id: z.uuid(),
    startsAt: z.string(),
    movieTitle: z.string(),
    roomName: z.string(),
  }),
  /** Seat labels, e.g. `["A1", "A2"]`; kept after the seats were released. */
  seatLabels: z.array(z.string()),
  /** Status of the newest payment attempt, or null when none was started. */
  paymentStatus: z.enum(PaymentStatus).nullable(),
});
export type AdminBooking = z.infer<typeof adminBookingSchema>;

export const adminBookingPageSchema = pageSchema(adminBookingSchema);

// ─── GET /admin/dashboard/revenue ───

/**
 * Cinema days of the revenue report, both included; at most `revenueDaysMax`. Without them, the
 * last `revenueDaysDefault` days up to today.
 */
export const revenueQuerySchema = z
  .object({ from: cinemaDateSchema.optional(), to: cinemaDateSchema.optional() })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['to'],
    error: 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu',
  })
  .refine(
    (query) =>
      !query.from ||
      !query.to ||
      daysInRange(query.from, query.to) <= ADMIN_REPORT_LIMITS.revenueDaysMax,
    { path: ['to'], error: `Tối đa ${ADMIN_REPORT_LIMITS.revenueDaysMax} ngày` },
  );
export type RevenueQuery = z.input<typeof revenueQuerySchema>;

/**
 * Revenue of one cinema day: the **total** (after voucher discount) of the bookings CONFIRMED that
 * day, by `confirmedAt` — when the money arrived. NEEDS_REVIEW bookings are not revenue (they are
 * refunded by hand), nor is a second payment of a booking (`REFUND_REQUIRED`).
 */
export const revenueDaySchema = z.object({
  date: z.string(),
  revenue: z.number().int(),
  bookings: z.number().int(),
  tickets: z.number().int(),
});
export type RevenueDay = z.infer<typeof revenueDaySchema>;

export const revenueReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** The time zone that decides which day a booking falls on (CINEMA_TZ). */
  timeZone: z.string(),
  /** Every day of the range, oldest first, days without sales included (zeros). */
  days: z.array(revenueDaySchema),
  totals: z.object({
    revenue: z.number().int(),
    bookings: z.number().int(),
    tickets: z.number().int(),
  }),
});
export type RevenueReport = z.infer<typeof revenueReportSchema>;

// ─── GET /admin/dashboard/occupancy ───

/** The cinema day whose showtimes to report; today by default. */
export const occupancyQuerySchema = z.object({ date: cinemaDateSchema.optional() });
export type OccupancyQuery = z.input<typeof occupancyQuerySchema>;

/**
 * Seats of one showtime. `totalSeats` counts sellable seats only (active seats); `occupancy` is
 * `soldSeats / totalSeats` (0–1), held seats not counted: a hold may still run out.
 */
export const showtimeOccupancySchema = z.object({
  id: z.uuid(),
  startsAt: z.string(),
  status: z.enum(ShowtimeStatus),
  movieTitle: z.string(),
  roomName: z.string(),
  totalSeats: z.number().int(),
  soldSeats: z.number().int(),
  /** HELD by a booking whose hold has not run out yet. */
  heldSeats: z.number().int(),
  occupancy: z.number(),
});
export type ShowtimeOccupancy = z.infer<typeof showtimeOccupancySchema>;

export const occupancyReportSchema = z.object({
  date: z.string(),
  /** Showtimes starting that day (cancelled ones included), by start time then room. */
  showtimes: z.array(showtimeOccupancySchema),
});
export type OccupancyReport = z.infer<typeof occupancyReportSchema>;
