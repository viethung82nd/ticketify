import { z } from 'zod';
import { PaymentStatus } from '../enums.js';

// ─── Requests ───

/** `POST /payments/vnpay`: start a VNPay payment for one of the user's PENDING bookings. */
export const createVnpayPaymentRequestSchema = z.object({ bookingId: z.uuid() });
export type CreateVnpayPaymentRequest = z.infer<typeof createVnpayPaymentRequestSchema>;

// ─── Responses ───

/** `201` body of `POST /payments/vnpay`. Each call is a new attempt with a new `txnRef`. */
export const createdVnpayPaymentSchema = z.object({
  paymentId: z.uuid(),
  /** `vnp_TxnRef`: 20 letters and digits. */
  txnRef: z.string(),
  /** Signed VNPay URL to send the browser to. */
  paymentUrl: z.url(),
  /** ISO instant: the booking's `expiresAt`, also sent to VNPay as `vnp_ExpireDate`. */
  expiresAt: z.string(),
});
export type CreatedVnpayPayment = z.infer<typeof createdVnpayPaymentSchema>;

/**
 * `GET /payments/vnpay/return`: what the result page may show. Display only: the API changes
 * nothing here (the IPN does, ROADMAP 3.4), so `paymentStatus` is whatever the database holds now
 * and stays PENDING until the IPN arrives, whatever `vnpResponseCode` says.
 */
export const vnpayReturnResultSchema = z.discriminatedUnion('verified', [
  /** Bad signature or unknown `vnp_TxnRef`: nothing else is disclosed. */
  z.object({ verified: z.literal(false) }),
  z.object({
    verified: z.literal(true),
    bookingId: z.uuid(),
    paymentStatus: z.enum(PaymentStatus),
    /** `vnp_ResponseCode` as VNPay sent it (`00` = VNPay reports success), or null if absent. */
    vnpResponseCode: z.string().nullable(),
    /** `vnp_Amount` ≠ amount × 100: never treat the result as a success. */
    amountMismatch: z.boolean(),
  }),
]);
export type VnpayReturnResult = z.infer<typeof vnpayReturnResultSchema>;

/** `vnp_ResponseCode` VNPay uses for a successful transaction. */
export const VNPAY_SUCCESS_CODE = '00';

// ─── MoMo (API v2 gateway, one-time wallet payment `captureWallet`) ───

/** `POST /payments/momo`: start (or resume) a MoMo payment for one of the user's PENDING bookings. */
export const createMomoPaymentRequestSchema = z.object({ bookingId: z.uuid() });
export type CreateMomoPaymentRequest = z.infer<typeof createMomoPaymentRequestSchema>;

/**
 * `201` body of `POST /payments/momo`. A booking has at most one live MoMo attempt: while it is
 * PENDING, calling again hands the same attempt back (`reused: true`, same `orderId`, same
 * `payUrl`) instead of opening a second MoMo order.
 */
export const createdMomoPaymentSchema = z.object({
  paymentId: z.uuid(),
  /** MoMo `orderId`: 20 letters and digits, unique across every payment. */
  orderId: z.string(),
  /** MoMo payment page to send the browser to. */
  payUrl: z.url(),
  /** ISO instant: the booking's `expiresAt`; past it the booking can no longer be paid. */
  expiresAt: z.string(),
  reused: z.boolean(),
});
export type CreatedMomoPayment = z.infer<typeof createdMomoPaymentSchema>;

/**
 * `GET /payments/momo/return`: what the result page may show for the query MoMo sent the browser
 * back with. Display only, like the VNPay one: `paymentStatus` is what the database holds now and
 * stays PENDING until MoMo's IPN arrives, whatever `resultCode` says.
 */
export const momoReturnResultSchema = z.discriminatedUnion('verified', [
  /** Bad signature, another merchant, or unknown `orderId`: nothing else is disclosed. */
  z.object({ verified: z.literal(false) }),
  z.object({
    verified: z.literal(true),
    bookingId: z.uuid(),
    paymentStatus: z.enum(PaymentStatus),
    /** `resultCode` as MoMo sent it (`0` = MoMo reports success), or null if absent. */
    resultCode: z.number().int().nullable(),
    /** `amount` ≠ the payment amount: never treat the result as a success. */
    amountMismatch: z.boolean(),
  }),
]);
export type MomoReturnResult = z.infer<typeof momoReturnResultSchema>;

/** MoMo `resultCode` of a successful transaction. */
export const MOMO_SUCCESS_CODE = 0;

/**
 * MoMo `resultCode`s documented as not final (the transaction can still change): `1000` waiting
 * for the user, `7000`/`7002` being processed, `8000` waiting for the user to confirm again,
 * `9000` authorized but not captured. Nothing is recorded for them; the result page keeps waiting.
 */
export const MOMO_PENDING_RESULT_CODES: readonly number[] = [1000, 7000, 7002, 8000, 9000];

// ─── SePay (bank transfer: VietQR shown here, money reported by SePay's webhook) ───

/** `POST /payments/sepay`: start (or resume) a bank transfer for one of the user's PENDING bookings. */
export const createSepayPaymentRequestSchema = z.object({ bookingId: z.uuid() });
export type CreateSepayPaymentRequest = z.infer<typeof createSepayPaymentRequestSchema>;

/**
 * `201` body of `POST /payments/sepay`: what the customer transfers, and where. A booking has at
 * most one open SePay attempt: while it is PENDING, calling again hands the same one back
 * (`reused: true`, same `transferContent`). Nothing here is a credential. The booking is confirmed
 * only when SePay's webhook reports the transfer; this answer never means "paid".
 */
export const createdSepayPaymentSchema = z.object({
  paymentId: z.uuid(),
  provider: z.literal('SEPAY'),
  /** VND, whole dong: the exact amount to transfer (any other amount is not applied). */
  amount: z.number().int().positive(),
  /** The exact transfer content: the payment code (prefix + 8 digits). */
  transferContent: z.string(),
  /** VietQR image (account, bank, amount and content already filled in). */
  qrCodeUrl: z.url(),
  /** Bank as VietQR names it. */
  bankCode: z.string(),
  accountNumber: z.string(),
  accountHolder: z.string().nullable(),
  /** ISO instant: the booking's `expiresAt`; a transfer after it may not get the seats. */
  expiresAt: z.string(),
  reused: z.boolean(),
});
export type CreatedSepayPayment = z.infer<typeof createdSepayPaymentSchema>;

/** Machine-readable `code` values of payment API errors (also BOOKING_NOT_FOUND, TOO_MANY_ATTEMPTS). */
export const PaymentErrorCode = {
  /** 404: no such booking, or it belongs to another user (never 403). */
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  /** 409: the booking is not PENDING (CONFIRMED, NEEDS_REVIEW, EXPIRED — cancelled included). */
  BOOKING_NOT_PAYABLE: 'BOOKING_NOT_PAYABLE',
  /** 422: the booking's `expiresAt` has passed; a new payment can no longer start. */
  BOOKING_EXPIRED: 'BOOKING_EXPIRED',
  /** 409: the booking already has a SUCCESS payment. */
  BOOKING_ALREADY_PAID: 'BOOKING_ALREADY_PAID',
  /**
   * 503: the gateway is not configured on this server (VNPay: TMN code, hash secret or return URL
   * missing; MoMo: partner code, access key, secret key, redirect URL or IPN URL missing; SePay:
   * webhook secret, account number or bank missing).
   */
  PAYMENT_NOT_CONFIGURED: 'PAYMENT_NOT_CONFIGURED',
  /** 422: the gateway does not accept this amount (MoMo wallet: 1 000 – 50 000 000 VND). */
  PAYMENT_AMOUNT_NOT_SUPPORTED: 'PAYMENT_AMOUNT_NOT_SUPPORTED',
  /**
   * 502: the gateway refused the payment request or answered something unusable. The attempt is
   * closed (FAILED); calling again starts a new one.
   */
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  /**
   * 503: the gateway could not be reached or did not answer in time. It may still have accepted
   * the request, so the attempt stays PENDING and calling again re-sends the very same request
   * (MoMo answers a repeated `requestId` idempotently) instead of opening a second order.
   */
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  /** 429: too many requests; `details.retryAfterSeconds`. Same code as login and booking. */
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
} as const;
export type PaymentErrorCode = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];
