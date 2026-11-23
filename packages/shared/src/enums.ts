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

/**
 * One row per payment attempt. PENDING ──► SUCCESS | FAILED | EXPIRED | REFUND_REQUIRED.
 * REFUND_REQUIRED: the gateway took the money, but another attempt had already paid the booking (a
 * booking is paid at most once); it is refunded by hand (week 12).
 */
export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  REFUND_REQUIRED: 'REFUND_REQUIRED',
} as const;
export type PaymentStatus = ValueOf<typeof PaymentStatus>;

/**
 * The gateway a payment attempt goes through (MoMo added 11/2026, SePay bank transfer 11/2026;
 * older rows are VNPAY).
 */
export const PaymentProvider = { VNPAY: 'VNPAY', MOMO: 'MOMO', SEPAY: 'SEPAY' } as const;
export type PaymentProvider = ValueOf<typeof PaymentProvider>;

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

/**
 * What one SePay bank-transaction webhook amounted to (`sepay_transactions.outcome`). Internal to
 * the API; shared so the enum check covers every Prisma enum. Only SETTLED applied the money to a
 * payment; every other incoming transfer is money on the account that a person must reconcile
 * (docs/SEPAY_SETUP.md "Đối soát").
 */
export const SepayTransactionOutcome = {
  /** Handed to `settlePayment`: confirmed, sent to review, or REFUND_REQUIRED (paid twice). */
  SETTLED: 'SETTLED',
  /** Money going out of the account: never settles anything. */
  OUTGOING: 'OUTGOING',
  /** Not our receiving account (nor its VA). */
  WRONG_ACCOUNT: 'WRONG_ACCOUNT',
  /** No Ticketify payment code in the transfer. */
  NO_REFERENCE: 'NO_REFERENCE',
  /** A well-formed payment code that no SePay payment has. */
  UNKNOWN_REFERENCE: 'UNKNOWN_REFERENCE',
  /** The amount differs from the payment's: nothing recorded on the payment. */
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  /** A second transfer for a payment that was already settled (a different SePay id). */
  DUPLICATE_TRANSFER: 'DUPLICATE_TRANSFER',
} as const;
export type SepayTransactionOutcome = ValueOf<typeof SepayTransactionOutcome>;

/** PERCENT: 1–100 % of the subtotal, optionally capped. FIXED: VND off the subtotal. */
export const VoucherDiscountType = { PERCENT: 'PERCENT', FIXED: 'FIXED' } as const;
export type VoucherDiscountType = ValueOf<typeof VoucherDiscountType>;

/** RESERVED ──► CONSUMED (booking confirmed) | RELEASED (booking expired) */
export const VoucherUsageStatus = {
  RESERVED: 'RESERVED',
  CONSUMED: 'CONSUMED',
  RELEASED: 'RELEASED',
} as const;
export type VoucherUsageStatus = ValueOf<typeof VoucherUsageStatus>;
