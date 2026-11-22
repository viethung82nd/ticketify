import { HttpStatus } from '@nestjs/common';
import { BookingStatus, PaymentErrorCode } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** The API errors of payment creation, shared by every gateway (same codes, same statuses). */
export const PaymentErrors = {
  bookingNotFound: () =>
    apiException(HttpStatus.NOT_FOUND, PaymentErrorCode.BOOKING_NOT_FOUND, 'Booking not found'),
  notPayable: (message = 'Only a booking waiting for payment can be paid') =>
    apiException(HttpStatus.CONFLICT, PaymentErrorCode.BOOKING_NOT_PAYABLE, message),
  bookingExpired: () =>
    apiException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      PaymentErrorCode.BOOKING_EXPIRED,
      'The time to pay for this booking is over',
    ),
  alreadyPaid: () =>
    apiException(
      HttpStatus.CONFLICT,
      PaymentErrorCode.BOOKING_ALREADY_PAID,
      'This booking has already been paid',
    ),
  notConfigured: () =>
    apiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      PaymentErrorCode.PAYMENT_NOT_CONFIGURED,
      'Online payment is not available right now',
    ),
} as const;

/**
 * How the booking row is locked while a payment attempt is created:
 * - `KEY_SHARE` (VNPay): concurrent attempts run side by side; a cancel or an expiry (both FOR
 *   UPDATE) cannot run at the same time;
 * - `NO_KEY_UPDATE` (MoMo): additionally serializes attempts of the same booking with each other,
 *   so two clicks cannot both open a MoMo order; it still does not block a foreign-key check
 *   (FOR KEY SHARE), so a VNPay attempt is never blocked by it.
 * Both conflict with FOR UPDATE, so `BookingService.cancel` and `expireBooking` keep their
 * guarantees (see `PaymentService.createVnpay`).
 */
export type BookingLock = 'KEY_SHARE' | 'NO_KEY_UPDATE';

interface PayableBookingRow {
  code: string;
  status: BookingStatus;
  total: number;
  expires_at: Date;
}

export interface PayableBooking {
  code: string;
  /** The amount to pay: the booking total as stored (VND, whole dong). */
  total: number;
  expiresAt: Date;
}

export interface PayableBookingInput {
  userId: string;
  bookingId: string;
  now: Date;
  lock: BookingLock;
  /**
   * An extra "too late" rule of the gateway, on top of `now >= expiresAt` (VNPay: the dates it
   * receives are whole seconds, so the last second is already too late).
   */
  tooLate?: (expiresAt: Date) => boolean;
}

/**
 * The user's booking, locked, if it can be paid now: it exists and is theirs (another user's is
 * "not found", never 403), it is PENDING, `expiresAt` has not passed, no payment of it succeeded,
 * and its total is a positive whole number of dong. Throws the matching API error otherwise. The
 * amount always comes from the database, never from the request.
 */
export async function lockPayableBooking(
  tx: Tx,
  input: PayableBookingInput,
): Promise<PayableBooking> {
  const { userId, bookingId, now } = input;
  const [booking] =
    input.lock === 'KEY_SHARE'
      ? await tx.$queryRaw<PayableBookingRow[]>`
          SELECT code, status::text AS status, total, expires_at FROM bookings
          WHERE id = ${bookingId}::uuid AND user_id = ${userId}::uuid
          FOR KEY SHARE`
      : await tx.$queryRaw<PayableBookingRow[]>`
          SELECT code, status::text AS status, total, expires_at FROM bookings
          WHERE id = ${bookingId}::uuid AND user_id = ${userId}::uuid
          FOR NO KEY UPDATE`;
  if (!booking) throw PaymentErrors.bookingNotFound();

  if (booking.status !== BookingStatus.PENDING) throw PaymentErrors.notPayable();
  if (now >= booking.expires_at || input.tooLate?.(booking.expires_at)) {
    throw PaymentErrors.bookingExpired();
  }
  const [paid] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments
    WHERE booking_id = ${bookingId}::uuid AND status = 'SUCCESS'
    LIMIT 1`;
  if (paid) throw PaymentErrors.alreadyPaid();

  const amount = booking.total;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw PaymentErrors.notPayable('This booking has nothing to pay online');
  }
  return { code: booking.code, total: amount, expiresAt: booking.expires_at };
}
