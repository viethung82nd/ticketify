/**
 * Domain enums shared by the API and the web app.
 *
 * Each enum must stay identical to the Prisma enum of the same name
 * (apps/api/prisma/schema.prisma); a unit test in apps/api fails if they drift.
 * Pattern: a frozen value object + a union type of its values.
 */

type ValueOf<T> = T[keyof T];

export const Role = { USER: 'USER', ADMIN: 'ADMIN', STAFF: 'STAFF' } as const;
export type Role = ValueOf<typeof Role>;

export const MovieStatus = {
  COMING_SOON: 'COMING_SOON',
  NOW_SHOWING: 'NOW_SHOWING',
  ENDED: 'ENDED',
} as const;
export type MovieStatus = ValueOf<typeof MovieStatus>;

/** Vietnamese film classification (Thông tư 05/2023/TT-BVHTTDL). */
export const AgeRating = { P: 'P', K: 'K', T13: 'T13', T16: 'T16', T18: 'T18', C: 'C' } as const;
export type AgeRating = ValueOf<typeof AgeRating>;

export const SeatType = { STANDARD: 'STANDARD', VIP: 'VIP', COUPLE: 'COUPLE' } as const;
export type SeatType = ValueOf<typeof SeatType>;

export const DayType = { WEEKDAY: 'WEEKDAY', WEEKEND: 'WEEKEND', HOLIDAY: 'HOLIDAY' } as const;
export type DayType = ValueOf<typeof DayType>;

export const ShowtimeStatus = { SCHEDULED: 'SCHEDULED', CANCELLED: 'CANCELLED' } as const;
export type ShowtimeStatus = ValueOf<typeof ShowtimeStatus>;

/** AVAILABLE ──hold──► HELD ──confirm──► SOLD; HELD ──release──► AVAILABLE */
export const ShowtimeSeatStatus = { AVAILABLE: 'AVAILABLE', HELD: 'HELD', SOLD: 'SOLD' } as const;
export type ShowtimeSeatStatus = ValueOf<typeof ShowtimeSeatStatus>;

/** PENDING ──► CONFIRMED | NEEDS_REVIEW | EXPIRED */
export const BookingStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  EXPIRED: 'EXPIRED',
} as const;
export type BookingStatus = ValueOf<typeof BookingStatus>;

/** One row per payment attempt. PENDING ──► SUCCESS | FAILED | EXPIRED */
export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type PaymentStatus = ValueOf<typeof PaymentStatus>;

/** ISSUED ──► CHECKED_IN; ISSUED ──► VOID */
export const TicketStatus = { ISSUED: 'ISSUED', CHECKED_IN: 'CHECKED_IN', VOID: 'VOID' } as const;
export type TicketStatus = ValueOf<typeof TicketStatus>;

/** Internal to the API/worker; shared so the enum check covers every Prisma enum. */
export const OutboxStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
} as const;
export type OutboxStatus = ValueOf<typeof OutboxStatus>;
