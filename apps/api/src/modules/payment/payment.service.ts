import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BookingStatus,
  type CreatedVnpayPayment,
  PaymentErrorCode,
  PaymentStatus,
  type VnpayReturnResult,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { AppConfig } from '../../config/app-config.service';
import type { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { newTxnRef, vnpayDate, vnpayIpAddr } from './vnpay/vnpay-format';
import { type VnpayQuery, VnpayService } from './vnpay/vnpay.service';

type Tx = Prisma.TransactionClient;

/**
 * Interactive-transaction limits of a payment creation. It waits on one row lock only: the
 * booking row, while a cancel or an expiry of the same booking holds it FOR UPDATE (milliseconds).
 * Same bounds as CANCEL_TX for that reason.
 */
const PAYMENT_TX = { maxWait: 5_000, timeout: 10_000 } as const;

/**
 * A new random `vnp_TxnRef` that collides with an existing one is skipped (ON CONFLICT DO NOTHING)
 * and drawn again. With 62^20 values a second draw is already astronomically unlikely; the bound
 * only keeps a bug from looping forever.
 */
const TXN_REF_ATTEMPTS = 3;

/** Values fixed by the VNPay payment API (pay.html), not by this application. */
const VNPAY = {
  version: '2.1.0',
  command: 'pay',
  currency: 'VND',
  /** Goods category; the documentation's own sample uses `other`. */
  orderType: 'other',
  locale: 'vn',
  /** `vnp_Amount` is in hundredths of a dong: 10,000 VND is sent as 1000000. */
  amountFactor: 100,
} as const;

export interface CreateVnpayPaymentInput {
  userId: string;
  bookingId: string;
  /** `req.ip`. */
  clientIp: string | undefined;
}

interface VnpaySettings {
  tmnCode: string;
  hashSecret: string;
  returnUrl: string;
  paymentUrl: string;
}

interface PayableBookingRow {
  code: string;
  status: BookingStatus;
  total: number;
  expires_at: Date;
}

const bookingNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, PaymentErrorCode.BOOKING_NOT_FOUND, 'Booking not found');
const notPayable = (message = 'Only a booking waiting for payment can be paid') =>
  apiException(HttpStatus.CONFLICT, PaymentErrorCode.BOOKING_NOT_PAYABLE, message);
const bookingExpired = () =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    PaymentErrorCode.BOOKING_EXPIRED,
    'The time to pay for this booking is over',
  );
const alreadyPaid = () =>
  apiException(
    HttpStatus.CONFLICT,
    PaymentErrorCode.BOOKING_ALREADY_PAID,
    'This booking has already been paid',
  );
const notConfigured = () =>
  apiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    PaymentErrorCode.PAYMENT_NOT_CONFIGURED,
    'Online payment is not available right now',
  );

/**
 * VNPay payments, creation and the return page (PLAN §5, ROADMAP 3.2–3.3). Payment results are
 * written by the IPN only (3.4): nothing here moves a payment or a booking to another status.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly vnpay: VnpayService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Starts one payment attempt for the user's PENDING booking: a new `Payment(PENDING)` with a new
   * `txnRef`, and the signed VNPay URL for it. Every call is a new attempt (a retry after a failed
   * or abandoned payment); earlier PENDING attempts stay as they are.
   *
   * Lock: the booking row `FOR KEY SHARE`, then the payment insert (whose foreign key needs the
   * same key-share lock anyway). FOR KEY SHARE does not conflict with itself, so several payment
   * attempts for one booking run side by side; it does conflict with FOR UPDATE, so a cancel
   * (`BookingService.cancel`, FOR UPDATE then reads payments) or an expiry (FOR UPDATE SKIP LOCKED)
   * of the same booking never runs at the same time as this:
   * - cancel first: this waits, then reads the booking EXPIRED → `409 BOOKING_NOT_PAYABLE`;
   * - this first: the cancel waits, then sees the new PENDING payment →
   *   `409 BOOKING_HAS_PAYMENT_IN_PROGRESS`; an expiry skips the booking and retries later.
   * The IPN (3.4) will lock Payment → Booking; this transaction locks no existing payment, so the
   * two cannot wait on each other in a cycle.
   */
  async createVnpay(input: CreateVnpayPaymentInput): Promise<CreatedVnpayPayment> {
    // Before any database work: without the merchant settings nothing can be signed.
    const settings = this.vnpaySettings();
    const now = this.clock.now();

    const created = await this.prisma.$transaction(
      (tx) => this.createInTransaction(tx, input, now),
      PAYMENT_TX,
    );

    // After the commit: building the URL writes nothing. `now` is the instant the checks used, so
    // vnp_CreateDate < vnp_ExpireDate has already been checked for exactly these two values.
    const query = this.vnpay.buildSignedQuery(
      {
        vnp_Version: VNPAY.version,
        vnp_Command: VNPAY.command,
        vnp_TmnCode: settings.tmnCode,
        vnp_Amount: created.amount * VNPAY.amountFactor,
        vnp_CurrCode: VNPAY.currency,
        vnp_TxnRef: created.txnRef,
        // Unaccented and without special characters, as VNPay asks.
        vnp_OrderInfo: `Thanh toan ve ${created.bookingCode}`,
        vnp_OrderType: VNPAY.orderType,
        vnp_Locale: VNPAY.locale,
        vnp_ReturnUrl: settings.returnUrl,
        vnp_IpAddr: vnpayIpAddr(input.clientIp),
        vnp_CreateDate: vnpayDate(now),
        vnp_ExpireDate: vnpayDate(created.expiresAt),
      },
      settings.hashSecret,
    );
    return {
      paymentId: created.paymentId,
      txnRef: created.txnRef,
      paymentUrl: `${settings.paymentUrl}?${query}`,
      expiresAt: created.expiresAt.toISOString(),
    };
  }

  private async createInTransaction(tx: Tx, input: CreateVnpayPaymentInput, now: Date) {
    // 1. FOR KEY SHARE, not FOR UPDATE: concurrent payment attempts do not block each other, but a
    //    cancel or an expiry (both FOR UPDATE) cannot run at the same time (see createVnpay).
    //    Another user's booking is "not found" as well (never 403).
    const [booking] = await tx.$queryRaw<PayableBookingRow[]>`
      SELECT code, status::text AS status, total, expires_at FROM bookings
      WHERE id = ${input.bookingId}::uuid AND user_id = ${input.userId}::uuid
      FOR KEY SHARE`;
    if (!booking) throw bookingNotFound();

    // 2. Payable: PENDING, before expiresAt (on the clock and in VNPay's whole seconds), unpaid.
    if (booking.status !== BookingStatus.PENDING) throw notPayable();
    if (now >= booking.expires_at || vnpayDate(booking.expires_at) <= vnpayDate(now)) {
      throw bookingExpired();
    }
    const [paid] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM payments
      WHERE booking_id = ${input.bookingId}::uuid AND status = 'SUCCESS'
      LIMIT 1`;
    if (paid) throw alreadyPaid();

    // 3. The amount is the booking total as stored (VND, whole dong).
    const amount = booking.total;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw notPayable('This booking has nothing to pay online');
    }

    // 4. A new attempt. payments_txn_ref_key decides uniqueness; a collision inserts nothing.
    for (let attempt = 0; attempt < TXN_REF_ATTEMPTS; attempt++) {
      const txnRef = newTxnRef();
      const [payment] = await tx.payment.createManyAndReturn({
        data: [
          {
            bookingId: input.bookingId,
            txnRef,
            amount,
            status: PaymentStatus.PENDING,
            createdAt: now,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      if (payment) {
        return {
          paymentId: payment.id,
          txnRef,
          amount,
          bookingCode: booking.code,
          expiresAt: booking.expires_at,
        };
      }
    }
    throw new Error(`No unused txnRef after ${TXN_REF_ATTEMPTS} attempts`);
  }

  /**
   * What the result page may show for the query VNPay sent the browser back with (`vnp_ReturnUrl`).
   * Display only: it changes nothing, and `vnp_ResponseCode = 00` is never taken as "paid" (the
   * IPN, signed server to server, is the only source of truth). A bad signature and an unknown
   * `vnp_TxnRef` both answer `{ verified: false }` and nothing more.
   */
  async vnpayReturn(query: VnpayQuery): Promise<VnpayReturnResult> {
    const { hashSecret } = this.vnpaySettings();
    if (!this.vnpay.verifySignature(query, hashSecret)) return { verified: false };

    const txnRef = query.vnp_TxnRef;
    if (typeof txnRef !== 'string') return { verified: false };
    const payment = await this.prisma.payment.findUnique({
      where: { txnRef },
      select: { bookingId: true, status: true, amount: true },
    });
    if (!payment) return { verified: false };

    const responseCode = query.vnp_ResponseCode;
    return {
      verified: true,
      bookingId: payment.bookingId,
      paymentStatus: payment.status,
      vnpResponseCode: typeof responseCode === 'string' ? responseCode : null,
      // Compared as strings: anything but exactly amount × 100 is a mismatch.
      amountMismatch: query.vnp_Amount !== String(payment.amount * VNPAY.amountFactor),
    };
  }

  /** The merchant settings, or `503 PAYMENT_NOT_CONFIGURED` when one is missing. Read per call. */
  private vnpaySettings(): VnpaySettings {
    const tmnCode = this.config.get('VNPAY_TMN_CODE');
    const hashSecret = this.config.get('VNPAY_HASH_SECRET');
    const returnUrl = this.config.get('VNPAY_RETURN_URL');
    if (!tmnCode || !hashSecret || !returnUrl) throw notConfigured();
    return { tmnCode, hashSecret, returnUrl, paymentUrl: this.config.get('VNPAY_PAYMENT_URL') };
  }
}
