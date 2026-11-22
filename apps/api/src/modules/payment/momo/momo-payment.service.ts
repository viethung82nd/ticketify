import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type CreatedMomoPayment,
  type MomoReturnResult,
  PaymentErrorCode,
  PaymentProvider,
  PaymentStatus,
} from '@ticketify/shared';
import { apiException } from '../../../common/errors/api-error';
import type { Prisma } from '../../../generated/prisma/client';
import { ClockService } from '../../../infra/clock/clock.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { SeatEvents } from '../../realtime/seat-events';
import { type ConfirmOutcome, settlePayment } from '../confirm-payment';
import { lockPayableBooking, PaymentErrors } from '../payable-booking';
import { TicketCodes } from '../seat-settlement';
import { newTxnRef } from '../vnpay/vnpay-format';
import {
  MOMO_AMOUNT_LIMITS,
  MomoClient,
  type MomoCreateAnswer,
  newMomoRequestId,
} from './momo.client';
import {
  type MomoResultFields,
  MomoResultState,
  momoResultState,
  readMomoReport,
  readMomoResultFields,
} from './momo-result';
import { verifyMomoSignature } from './momo-signature';

type Tx = Prisma.TransactionClient;

/** Same bounds as the VNPay creation and IPN: they wait on row locks held for milliseconds. */
const PAYMENT_TX = { maxWait: 5_000, timeout: 10_000 } as const;
const IPN_TX = { maxWait: 5_000, timeout: 10_000 } as const;

/** A new random `orderId` colliding with an existing `txn_ref` is drawn again (see VNPay). */
const ORDER_ID_ATTEMPTS = 3;

/** The longest piece of a request-supplied value that may reach a log line. */
const LOG_VALUE_MAX = 64;
const forLog = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, LOG_VALUE_MAX) : '-';

export interface CreateMomoPaymentInput {
  userId: string;
  bookingId: string;
}

/** The attempt a creation hands to MoMo: a new one, or the booking's open one. */
interface Attempt {
  paymentId: string;
  orderId: string;
  requestId: string;
  amount: number;
  bookingCode: string;
  expiresAt: Date;
  /** Set once MoMo accepted the create call; then MoMo is not called again. */
  payUrl: string | null;
  reused: boolean;
}

interface OpenAttemptRow {
  id: string;
  txn_ref: string;
  provider_request_id: string;
  pay_url: string | null;
  amount: number;
}

/**
 * What the IPN endpoint answers MoMo. MoMo's documentation: "You need to respond with HTTP code
 * 204 (No Content)" within 15 seconds. 204 tells MoMo the notification was handled — recorded, a
 * repeat, still in progress, or about an order we do not have — so it is final either way. A body
 * that cannot be verified gets 400, and an unexpected error 500 with nothing written, so MoMo
 * calls again if it retries.
 */
export type MomoIpnResult =
  { acknowledged: true; outcome: string } | { acknowledged: false; reason: string };

const providerError = (resultCode: number) =>
  apiException(
    HttpStatus.BAD_GATEWAY,
    PaymentErrorCode.PAYMENT_PROVIDER_ERROR,
    'MoMo could not create the payment, please try again or choose another method',
    { resultCode },
  );
const providerUnavailable = () =>
  apiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE,
    'MoMo is not answering right now, please try again in a moment',
  );
const amountNotSupported = () =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    PaymentErrorCode.PAYMENT_AMOUNT_NOT_SUPPORTED,
    `MoMo accepts ${MOMO_AMOUNT_LIMITS.min}–${MOMO_AMOUNT_LIMITS.max} VND per payment`,
  );
const attemptClosed = () => PaymentErrors.notPayable('This payment attempt is no longer open');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * MoMo payments: creation, the IPN and the return page (one-time wallet payment, payment gateway
 * API v2). Like VNPay, payment results are written by the IPN only (and by the booking expiry
 * when MoMo's query reports a payment the IPN never brought); creation and the return page never
 * mark anything paid. Recording a result goes through `settlePayment`, the same code, locks and
 * outbox events as a VNPay IPN, so the booking, the seats, the tickets and the delivery jobs
 * (PDF, email, notification) behave exactly the same whichever gateway took the money.
 */
@Injectable()
export class MomoPaymentService {
  private readonly logger = new Logger(MomoPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly momo: MomoClient,
    private readonly seatEvents: SeatEvents,
    private readonly ticketCodes: TicketCodes,
  ) {}

  // ─── Creation ───

  /**
   * Gives the user's PENDING booking a MoMo payment page. A booking has at most one open MoMo
   * attempt (PENDING): while it has one, that attempt is handed back (`reused`) instead of a new
   * MoMo order, so two clicks or two tabs never produce two payable orders. A VNPay attempt is
   * independent of it, as before (a booking paid twice is REFUND_REQUIRED, ROADMAP 3.4).
   *
   * 1. In a transaction: the booking locked FOR NO KEY UPDATE (attempts of one booking queue
   *    here; a cancel or an expiry cannot run at the same time), the same checks and errors as
   *    VNPay, MoMo's amount range, then the open attempt or a new `Payment(PENDING, MOMO)` with a
   *    new `orderId` and `requestId`. It commits before MoMo is called: no HTTP call while a lock
   *    is held (PLAN §4), and the IPN can only ever arrive for a payment that already exists.
   * 2. An attempt that already has a `payUrl` is returned as it is; otherwise MoMo is called with
   *    the attempt's own `orderId` and `requestId`. A re-sent request is the very same request,
   *    which MoMo answers idempotently, so a timeout never opens a second order:
   *    - created → `payUrl` stored, returned;
   *    - refused (a final error) → the attempt FAILED (it never had a page), `502`;
   *    - no usable answer (timeout, network, in progress) → the attempt stays PENDING, `503`;
   *      the next call re-sends it.
   */
  async create(input: CreateMomoPaymentInput): Promise<CreatedMomoPayment> {
    const settings = this.momo.createSettings();
    if (!settings) throw PaymentErrors.notConfigured();
    const now = this.clock.now();

    const attempt = await this.prisma.$transaction(
      (tx) => this.openAttempt(tx, input, now),
      PAYMENT_TX,
    );
    const ref = `payment ${attempt.paymentId} (MoMo orderId ${attempt.orderId}, booking ${input.bookingId})`;
    if (attempt.payUrl) {
      this.logger.log(`MoMo create: ${ref} still open, its payment page handed back`);
      return this.created(attempt, attempt.payUrl);
    }

    const answer = await this.momo.create(settings, {
      orderId: attempt.orderId,
      requestId: attempt.requestId,
      amount: attempt.amount,
      // Unaccented, like the VNPay order description.
      orderInfo: `Thanh toan ve ${attempt.bookingCode}`,
    });
    return this.afterCreate(attempt, answer, ref, now);
  }

  private async afterCreate(
    attempt: Attempt,
    answer: MomoCreateAnswer,
    ref: string,
    now: Date,
  ): Promise<CreatedMomoPayment> {
    switch (answer.kind) {
      case 'created': {
        const stored = await this.prisma.$executeRaw`
          UPDATE payments SET pay_url = ${answer.payUrl}, updated_at = ${now}
          WHERE id = ${attempt.paymentId}::uuid AND status = 'PENDING' AND provider = 'MOMO'`;
        // Expired (or settled) while MoMo was answering: the page must not be handed out.
        if (stored !== 1) throw attemptClosed();
        this.logger.log(`MoMo create: ${ref} created`);
        return this.created(attempt, answer.payUrl);
      }
      case 'refused': {
        const failed = await this.prisma.$executeRaw`
          UPDATE payments
          SET status = 'FAILED', response_code = ${String(answer.resultCode)},
              raw_payload = ${JSON.stringify(answer.body)}::jsonb,
              processed_at = ${now}, updated_at = ${now}
          WHERE id = ${attempt.paymentId}::uuid AND status = 'PENDING' AND pay_url IS NULL`;
        this.logger.warn(
          `MoMo create: ${ref} refused by MoMo (resultCode ${answer.resultCode}); ` +
            `${failed === 1 ? 'attempt FAILED' : 'attempt already closed'}`,
        );
        throw providerError(answer.resultCode);
      }
      case 'unavailable':
        this.logger.warn(
          `MoMo create: ${ref} got no usable answer (${answer.reason}); attempt left PENDING, ` +
            'the next call re-sends the same request',
        );
        throw providerUnavailable();
    }
  }

  private created(attempt: Attempt, payUrl: string): CreatedMomoPayment {
    return {
      paymentId: attempt.paymentId,
      orderId: attempt.orderId,
      payUrl,
      expiresAt: attempt.expiresAt.toISOString(),
      reused: attempt.reused,
    };
  }

  private async openAttempt(tx: Tx, input: CreateMomoPaymentInput, now: Date): Promise<Attempt> {
    const booking = await lockPayableBooking(tx, { ...input, now, lock: 'NO_KEY_UPDATE' });
    if (booking.total < MOMO_AMOUNT_LIMITS.min || booking.total > MOMO_AMOUNT_LIMITS.max) {
      throw amountNotSupported();
    }
    const base = {
      amount: booking.total,
      bookingCode: booking.code,
      expiresAt: booking.expiresAt,
    };

    // The booking's open MoMo attempt, if any. The booking row lock above makes this read and
    // the insert below one step for every other MoMo creation of the booking.
    const [open] = await tx.$queryRaw<OpenAttemptRow[]>`
      SELECT id, txn_ref, provider_request_id, pay_url, amount FROM payments
      WHERE booking_id = ${input.bookingId}::uuid AND provider = 'MOMO' AND status = 'PENDING'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;
    if (open && open.amount === booking.total) {
      return {
        ...base,
        paymentId: open.id,
        orderId: open.txn_ref,
        requestId: open.provider_request_id,
        payUrl: open.pay_url,
        reused: true,
      };
    }

    for (let attempt = 0; attempt < ORDER_ID_ATTEMPTS; attempt++) {
      const orderId = newTxnRef();
      const requestId = newMomoRequestId();
      const [payment] = await tx.payment.createManyAndReturn({
        data: [
          {
            bookingId: input.bookingId,
            provider: PaymentProvider.MOMO,
            txnRef: orderId,
            providerRequestId: requestId,
            amount: booking.total,
            status: PaymentStatus.PENDING,
            createdAt: now,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      if (payment) {
        return { ...base, paymentId: payment.id, orderId, requestId, payUrl: null, reused: false };
      }
    }
    throw new Error(`No unused MoMo orderId after ${ORDER_ID_ATTEMPTS} attempts`);
  }

  // ─── IPN ───

  /**
   * One MoMo IPN (`POST /payments/momo/ipn`, server to server, JSON). In this order:
   * 1. the body is an object with every field we act on, well typed → else 400;
   * 2. its signature (the documented 13-field `result` signature) is valid → else 400;
   * 3. `partnerCode` is ours → else 400;
   * 4. a MoMo payment has this `orderId`, created with this `requestId` → else 204 and a warning
   *    (nothing to record; an IPN of another environment sharing the sandbox account);
   * 5. `resultCode` is not final (1000, 7000, 7002, 8000, 9000) → 204, nothing changes;
   * 6. otherwise `settlePayment` in one transaction: amount check (≠ → nothing written, error
   *    log), repeated IPN (nothing written), FAILED, REFUND_REQUIRED, CONFIRMED or NEEDS_REVIEW
   *    → 204. Any error rolls everything back and becomes 500.
   * Steps 1–5 write nothing. The payment row lock and its final statuses make a repeated or
   * concurrent IPN a no-op, and the outbox event that starts the PDF, email and notification is
   * written in the same transaction as the confirmation, so it exists exactly once.
   */
  async ipn(body: unknown): Promise<MomoIpnResult> {
    const merchant = this.momo.merchant();
    // Thrown, not answered: a server without keys must not tell MoMo "handled" (500, MoMo retries).
    if (!merchant) throw new Error('MOMO_* keys are not set: the IPN cannot be verified');

    if (!isRecord(body)) return this.reject('-', 'the body is not a JSON object');
    const claimed = forLog(body.orderId);
    const fields = readMomoResultFields(body);
    if (!fields) return this.reject(claimed, 'a required field is missing or malformed');
    if (!verifyMomoSignature('result', body, merchant)) {
      return this.reject(claimed, 'invalid signature');
    }
    if (fields.partnerCode !== merchant.partnerCode) {
      return this.reject(claimed, `partnerCode ${forLog(fields.partnerCode)} is not ours`);
    }

    const ref = `MoMo orderId ${fields.orderId} (transId ${fields.transId}, resultCode ${fields.resultCode})`;
    const unknown = await this.knownAttempt(fields);
    if (unknown !== null) {
      this.logger.warn(`MoMo IPN: ${ref}: ${unknown}; nothing changed`);
      return { acknowledged: true, outcome: 'ignored' };
    }
    if (momoResultState(fields.resultCode) === MomoResultState.PENDING) {
      this.logger.log(`MoMo IPN: ${ref}: not final yet; nothing changed`);
      return { acknowledged: true, outcome: 'pending' };
    }

    const now = this.clock.now();
    const result = await this.prisma.$transaction(
      (tx) =>
        settlePayment(tx, {
          provider: PaymentProvider.MOMO,
          txnRef: fields.orderId,
          report: readMomoReport(fields, body),
          now,
          ticketCode: () => this.ticketCodes.next(),
        }),
      IPN_TX,
    );
    // After the commit only, as for VNPay (best-effort, never throws).
    if (result.outcome === 'confirmed') this.seatEvents.sold(result.showtimeId, result.seatIds);
    if (result.outcome === 'needs_review') {
      this.seatEvents.released(result.showtimeId, result.releasedSeatIds);
    }
    this.logSettled(ref, result);
    return { acknowledged: true, outcome: result.outcome };
  }

  /**
   * Whether the result is about one of our MoMo attempts, read without a lock: `txn_ref`,
   * `provider` and `provider_request_id` never change once a payment exists. `null` when it is;
   * otherwise why not.
   */
  private async knownAttempt(fields: MomoResultFields): Promise<string | null> {
    const [payment] = await this.prisma.$queryRaw<{ provider_request_id: string | null }[]>`
      SELECT provider_request_id FROM payments
      WHERE txn_ref = ${fields.orderId} AND provider = 'MOMO'`;
    if (!payment) return 'no MoMo payment has this orderId';
    if (payment.provider_request_id !== fields.requestId) {
      return `requestId ${forLog(fields.requestId)} is not the one this order was created with`;
    }
    return null;
  }

  private reject(orderId: string, reason: string): MomoIpnResult {
    this.logger.warn(`MoMo IPN 400: ${reason} (orderId ${orderId}); nothing changed`);
    return { acknowledged: false, reason };
  }

  /** One line per recorded IPN, with the ids needed to follow it up; never the signature. */
  private logSettled(ref: string, result: ConfirmOutcome): void {
    switch (result.outcome) {
      case 'not_found':
        this.logger.warn(`MoMo IPN: ${ref}: no MoMo payment found under lock; nothing changed`);
        return;
      case 'invalid_amount':
        this.logger.error(
          `MoMo IPN: ${ref}: payment ${result.paymentId} expects amount ${result.expected}, ` +
            `MoMo reported ${result.received ?? '(none)'}; nothing changed`,
        );
        return;
      case 'already_processed':
        this.logger.log(`MoMo IPN: ${ref}: payment ${result.paymentId} already ${result.status}`);
        return;
      case 'failed':
        this.logger.log(
          `MoMo IPN: ${ref}: payment ${result.paymentId} FAILED; booking ${result.bookingId} unchanged`,
        );
        return;
      case 'paid_twice':
        this.logger.error(
          `MoMo IPN: ${ref}: payment ${result.paymentId} was paid, but booking ${result.bookingId} ` +
            `was already paid by payment ${result.paidPaymentId}: REFUND_REQUIRED, refund it by hand`,
        );
        return;
      case 'confirmed':
        this.logger.log(
          `MoMo IPN: ${ref}: payment ${result.paymentId} SUCCESS, booking ${result.bookingId} ` +
            `CONFIRMED${result.reclaimed ? ' after taking its seats back' : ''}, ` +
            `${result.ticketIds.length} ticket(s)`,
        );
        return;
      case 'needs_review':
        this.logger.warn(
          `MoMo IPN: ${ref}: payment ${result.paymentId} SUCCESS, booking ${result.bookingId} ` +
            `NEEDS_REVIEW (${result.problem.reason}), ${result.releasedSeatIds.length} of its own ` +
            'HELD seat(s) released',
        );
        return;
    }
  }

  // ─── Return page ───

  /**
   * What the result page may show for the query MoMo sent the browser back with (`redirectUrl`).
   * Display only: it changes nothing, and `resultCode = 0` is never taken as "paid" (the IPN is
   * the source of truth). The query carries the same fields and signature as the IPN, as strings.
   * Anything that does not verify answers `{ verified: false }` and nothing more.
   */
  async verifyReturn(query: Readonly<Record<string, unknown>>): Promise<MomoReturnResult> {
    const merchant = this.momo.merchant();
    if (!merchant) throw PaymentErrors.notConfigured();
    // Express turns a repeated key into an array: never valid.
    if (Object.values(query).some((value) => typeof value !== 'string')) return { verified: false };

    const fields = readMomoResultFields(query);
    if (!fields || fields.partnerCode !== merchant.partnerCode) return { verified: false };
    if (!verifyMomoSignature('result', query, merchant)) return { verified: false };

    const payment = await this.prisma.payment.findFirst({
      where: { txnRef: fields.orderId, provider: PaymentProvider.MOMO },
      select: { bookingId: true, status: true, amount: true, providerRequestId: true },
    });
    if (!payment || payment.providerRequestId !== fields.requestId) return { verified: false };
    return {
      verified: true,
      bookingId: payment.bookingId,
      paymentStatus: payment.status,
      resultCode: fields.resultCode,
      amountMismatch: fields.amount !== payment.amount,
    };
  }
}
