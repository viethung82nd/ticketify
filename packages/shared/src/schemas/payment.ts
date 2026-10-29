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
  /** 503: VNPay is not configured on this server (TMN code, hash secret or return URL missing). */
  PAYMENT_NOT_CONFIGURED: 'PAYMENT_NOT_CONFIGURED',
  /** 429: too many requests; `details.retryAfterSeconds`. Same code as login and booking. */
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
} as const;
export type PaymentErrorCode = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];
