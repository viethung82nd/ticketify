import { Injectable, Logger } from '@nestjs/common';
import {
  type CreatedSepayPayment,
  PaymentProvider,
  PaymentStatus,
  SepayTransactionOutcome,
} from '@ticketify/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { ClockService } from '../../../infra/clock/clock.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { SeatEvents } from '../../realtime/seat-events';
import { type ConfirmOutcome, settlePayment } from '../confirm-payment';
import { lockPayableBooking, PaymentErrors } from '../payable-booking';
import type { PaymentReport } from '../payment-report';
import { TicketCodes } from '../seat-settlement';
import { SepayConfig, type SepaySettings } from './sepay.config';
import { newPaymentCode, referenceOf, vietQrUrl } from './sepay-reference';
import {
  parseSepayWebhook,
  SEPAY_HEADERS,
  type SepayWebhook,
  verifySepaySignature,
} from './sepay-webhook.validator';

type Tx = Prisma.TransactionClient;

/** Same bounds as the VNPay and MoMo creation and IPN: they wait on row locks held for milliseconds. */
const PAYMENT_TX = { maxWait: 5_000, timeout: 10_000 } as const;
const WEBHOOK_TX = { maxWait: 5_000, timeout: 10_000 } as const;

/** A new random payment code colliding with an existing `txn_ref` is drawn again. */
const CODE_ATTEMPTS = 5;

export interface CreateSepayPaymentInput {
  userId: string;
  bookingId: string;
}

interface Attempt {
  paymentId: string;
  code: string;
  amount: number;
  expiresAt: Date;
  reused: boolean;
}

/** One webhook delivery as the controller received it. */
export interface SepayDelivery {
  body: unknown;
  /** The request body bytes as received (Nest `rawBody: true`); what the signature covers. */
  rawBody: Buffer | undefined;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  contentType: string | undefined;
}

/**
 * What the webhook endpoint answers. SePay counts a delivery as received only on HTTP 200/201 with
 * the JSON body `{"success": true}` within 30 s (developer.sepay.vn/vi/sepay-webhooks/
 * tich-hop-webhook); anything else is a failure it may retry (8 sends over ~33 min with "Tự động
 * gửi lại khi server trả lỗi" on; network errors always). So every authenticated, well-formed
 * transaction is acknowledged, whatever it turned out to be — a retry would only repeat it — and
 * only an unauthenticated, malformed, unconfigured or failed (rolled back) delivery is not.
 */
export type SepayWebhookResult =
  | { status: 200; outcome: SepayTransactionOutcome | 'duplicate' }
  | { status: 400 | 401 | 503; reason: string };

/** What the webhook decided before touching the database. */
type Plan =
  | { settle: false; outcome: SepayTransactionOutcome; reference: string | null }
  | { settle: true; reference: string };

/** Outcomes of `settlePayment` that applied the money (wrote the payment). */
const SETTLED: ReadonlySet<ConfirmOutcome['outcome']> = new Set([
  'confirmed',
  'needs_review',
  'paid_twice',
]);

/** The longest piece of a request-supplied value that may reach a log line. */
const LOG_VALUE_MAX = 64;
const forLog = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, LOG_VALUE_MAX) : '-';

/**
 * SePay bank transfers: the customer transfers the exact amount with the payment code as content,
 * to the account shown as a VietQR; SePay watches that account and POSTs every transaction to our
 * webhook. As for VNPay and MoMo, a payment is only ever recorded from the gateway's
 * server-to-server message, never from the browser, and recording goes through `settlePayment`:
 * the same locks, outcomes and outbox events (PDF, email, notification), whichever gateway took
 * the money. SePay has no "failed" message: an unpaid attempt simply expires with its booking.
 */
@Injectable()
export class SepayPaymentService {
  private readonly logger = new Logger(SepayPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly config: SepayConfig,
    private readonly seatEvents: SeatEvents,
    private readonly ticketCodes: TicketCodes,
  ) {}

  // ─── Creation ───

  /**
   * The transfer details of the user's PENDING booking. One transaction: the booking locked FOR
   * NO KEY UPDATE (SePay attempts of one booking queue here; a cancel or an expiry cannot run at
   * the same time), the checks and errors every gateway shares (`lockPayableBooking`), then the
   * booking's open SePay attempt or a new `Payment(PENDING, SEPAY)` with a new payment code. No
   * call to SePay is needed: the QR is a plain VietQR image URL.
   */
  async create(input: CreateSepayPaymentInput): Promise<CreatedSepayPayment> {
    const settings = this.config.settings();
    if (!settings) throw PaymentErrors.notConfigured();
    const now = this.clock.now();
    const attempt = await this.prisma.$transaction(
      (tx) => this.openAttempt(tx, input, settings, now),
      PAYMENT_TX,
    );
    this.logger.log(
      `SePay create: payment ${attempt.paymentId} (code ${attempt.code}, booking ` +
        `${input.bookingId}) ${attempt.reused ? 'still open, handed back' : 'created'}`,
    );
    return {
      paymentId: attempt.paymentId,
      provider: PaymentProvider.SEPAY,
      amount: attempt.amount,
      transferContent: attempt.code,
      qrCodeUrl: vietQrUrl({
        accountNumber: settings.accountNumber,
        bankCode: settings.bankCode,
        accountHolder: settings.accountHolder,
        amount: attempt.amount,
        transferContent: attempt.code,
      }),
      bankCode: settings.bankCode,
      accountNumber: settings.accountNumber,
      accountHolder: settings.accountHolder,
      expiresAt: attempt.expiresAt.toISOString(),
      reused: attempt.reused,
    };
  }

  private async openAttempt(
    tx: Tx,
    input: CreateSepayPaymentInput,
    settings: SepaySettings,
    now: Date,
  ): Promise<Attempt> {
    const booking = await lockPayableBooking(tx, { ...input, now, lock: 'NO_KEY_UPDATE' });
    const base = { amount: booking.total, expiresAt: booking.expiresAt };

    // The booking row lock above makes this read and the insert below one step for every other
    // SePay creation of the booking: two clicks or two tabs get the same code.
    const [open] = await tx.$queryRaw<{ id: string; txn_ref: string; amount: number }[]>`
      SELECT id, txn_ref, amount FROM payments
      WHERE booking_id = ${input.bookingId}::uuid AND provider = 'SEPAY' AND status = 'PENDING'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;
    if (open && open.amount === booking.total) {
      return { ...base, paymentId: open.id, code: open.txn_ref, reused: true };
    }

    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = newPaymentCode(settings.paymentCodePrefix);
      const [payment] = await tx.payment.createManyAndReturn({
        data: [
          {
            bookingId: input.bookingId,
            provider: PaymentProvider.SEPAY,
            txnRef: code,
            amount: booking.total,
            status: PaymentStatus.PENDING,
            createdAt: now,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      if (payment) return { ...base, paymentId: payment.id, code, reused: false };
    }
    throw new Error(`No unused SePay payment code after ${CODE_ATTEMPTS} attempts`);
  }

  // ─── Webhook ───

  /**
   * One SePay webhook delivery (`POST /payments/sepay/webhook`). In this order, nothing written
   * until step 5:
   * 1. SePay configured → else 503 (SePay's retry policy decides whether it calls again);
   * 2. `X-SePay-Signature` is the HMAC of `{X-SePay-Timestamp}.{raw body}` and the timestamp is
   *    within 300 s → else 401;
   * 3. JSON body with every field we act on, well typed → else 400;
   * 4. classify: money out, another account, or no Ticketify payment code → recorded, settles
   *    nothing; otherwise the payment code names the attempt to settle;
   * 5. one transaction: the transaction row inserted under its unique SePay id (a repeated or
   *    concurrent delivery of the same id inserts nothing → `duplicate`, nothing else happens),
   *    then `settlePayment` (payment → booking → seats locks; exact amount; a payment already
   *    settled settles nothing) and the row's final outcome. Any error rolls everything back → 500.
   */
  async webhook(delivery: SepayDelivery): Promise<SepayWebhookResult> {
    const settings = this.config.settings();
    if (!settings) {
      this.logger.error('SePay webhook 503: SEPAY_* settings are not set; nothing changed');
      return { status: 503, reason: 'SePay is not configured' };
    }

    const auth = verifySepaySignature({
      secret: settings.webhookSecret,
      signature: delivery.headers[SEPAY_HEADERS.signature],
      timestamp: delivery.headers[SEPAY_HEADERS.timestamp],
      rawBody: delivery.rawBody,
      now: this.clock.now(),
    });
    if (!auth.ok) {
      this.logger.warn(`SePay webhook 401: ${auth.reason}; nothing changed`);
      return { status: 401, reason: 'Invalid signature' };
    }

    if (!delivery.contentType?.toLowerCase().startsWith('application/json')) {
      this.logger.warn(
        `SePay webhook 400: content type ${forLog(delivery.contentType)} (the webhook must use ` +
          'JSON); nothing changed',
      );
      return { status: 400, reason: 'Invalid payload' };
    }
    const parsed = parseSepayWebhook(delivery.body);
    if (!parsed.ok) {
      this.logger.warn(`SePay webhook 400: ${parsed.reason}; nothing changed`);
      return { status: 400, reason: 'Invalid payload' };
    }
    const { webhook } = parsed;

    const plan = this.plan(webhook, settings);
    const now = this.clock.now();
    const done = await this.prisma.$transaction(
      (tx) => this.record(tx, webhook, plan, now),
      WEBHOOK_TX,
    );
    if (done === 'duplicate') {
      this.logger.log(`SePay webhook: transaction ${webhook.id} already received; nothing changed`);
      return { status: 200, outcome: 'duplicate' };
    }
    // After the commit only, as for VNPay and MoMo (best-effort, never throws).
    const { outcome, settlement } = done;
    if (settlement?.outcome === 'confirmed') {
      this.seatEvents.sold(settlement.showtimeId, settlement.seatIds);
    }
    if (settlement?.outcome === 'needs_review') {
      this.seatEvents.released(settlement.showtimeId, settlement.releasedSeatIds);
    }
    this.logRecorded(webhook, plan.reference, outcome, settlement);
    return { status: 200, outcome };
  }

  /** Step 4: which transfers may settle a payment at all. Pure, reads no database. */
  private plan(webhook: SepayWebhook, settings: SepaySettings): Plan {
    const reference = referenceOf(webhook, settings.paymentCodePrefix);
    if (webhook.transferType !== 'in') {
      return { settle: false, outcome: SepayTransactionOutcome.OUTGOING, reference };
    }
    const ours =
      webhook.accountNumber === settings.accountNumber ||
      webhook.subAccount === settings.accountNumber;
    if (!ours) return { settle: false, outcome: SepayTransactionOutcome.WRONG_ACCOUNT, reference };
    if (!reference) {
      return { settle: false, outcome: SepayTransactionOutcome.NO_REFERENCE, reference: null };
    }
    return { settle: true, reference };
  }

  /**
   * Step 5, inside one transaction. The INSERT ... ON CONFLICT DO NOTHING on `sepay_id` is the
   * idempotency gate: a concurrent delivery of the same id waits on the unique index until this
   * transaction ends, then inserts nothing (or, if this one rolled back, does the work itself).
   * The row is written before any payment lock and no other flow touches this table, so the lock
   * order of `settlePayment` (payment → booking → seats) stays the only one that matters.
   */
  private async record(
    tx: Tx,
    webhook: SepayWebhook,
    plan: Plan,
    now: Date,
  ): Promise<
    'duplicate' | { outcome: SepayTransactionOutcome; settlement: ConfirmOutcome | null }
  > {
    // Provisional for a transfer to settle; replaced below in the same transaction.
    const initial = plan.settle ? SepayTransactionOutcome.UNKNOWN_REFERENCE : plan.outcome;
    // createManyAndReturn + skipDuplicates = INSERT ... ON CONFLICT DO NOTHING RETURNING.
    const [row] = await tx.sepayTransaction.createManyAndReturn({
      data: [
        {
          sepayId: BigInt(webhook.id),
          outcome: initial,
          transferType: webhook.transferType,
          transferAmount: BigInt(webhook.transferAmount),
          accountNumber: webhook.accountNumber,
          subAccount: webhook.subAccount || null,
          code: webhook.code ?? null,
          reference: plan.reference,
          content: webhook.content ?? null,
          referenceCode: webhook.referenceCode || null,
          gateway: webhook.gateway ?? null,
          transactionDate: webhook.transactionDate ?? null,
          rawPayload: webhook as Prisma.InputJsonObject,
          receivedAt: now,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (!row) return 'duplicate';
    if (!plan.settle) return { outcome: plan.outcome, settlement: null };

    const settlement = await settlePayment(tx, {
      provider: PaymentProvider.SEPAY,
      txnRef: plan.reference,
      report: sepayReport(webhook),
      now,
      ticketCode: () => this.ticketCodes.next(),
    });
    const outcome = outcomeOf(settlement);
    const paymentId = settlement.outcome === 'not_found' ? null : settlement.paymentId;
    await tx.$executeRaw`
      UPDATE sepay_transactions
      SET outcome = ${outcome}::sepay_transaction_outcome, payment_id = ${paymentId}::uuid
      WHERE id = ${row.id}::uuid`;
    return { outcome, settlement };
  }

  /**
   * One line per recorded transaction. Money that came in but was not applied to a booking is an
   * error with a fixed `event` name, so it can be found and counted: a person must reconcile it
   * (docs/SEPAY_SETUP.md "Đối soát"). Never the signature, a header or the whole payload.
   */
  private logRecorded(
    webhook: SepayWebhook,
    reference: string | null,
    outcome: SepayTransactionOutcome,
    settlement: ConfirmOutcome | null,
  ): void {
    const ref =
      `SePay transaction ${webhook.id} (${webhook.transferType} ${webhook.transferAmount} VND, ` +
      `code ${reference ?? '-'})`;
    if (outcome === SepayTransactionOutcome.SETTLED && settlement) {
      this.logSettled(ref, settlement);
      return;
    }
    if (outcome === SepayTransactionOutcome.OUTGOING) {
      this.logger.log(`SePay webhook: ${ref}: money out, recorded; nothing settled`);
      return;
    }
    const details = {
      event: 'sepay.transfer_unapplied',
      provider: PaymentProvider.SEPAY,
      sepayId: webhook.id,
      outcome,
      amount: webhook.transferAmount,
      reference,
      paymentId: settlement && settlement.outcome !== 'not_found' ? settlement.paymentId : null,
      expectedAmount: settlement?.outcome === 'invalid_amount' ? settlement.expected : null,
    };
    // A transfer without our code or to another account may be ordinary business of the account.
    if (
      outcome === SepayTransactionOutcome.NO_REFERENCE ||
      outcome === SepayTransactionOutcome.WRONG_ACCOUNT
    ) {
      this.logger.warn(details, `SePay webhook: ${ref}: ${outcome}, recorded; nothing settled`);
      return;
    }
    this.logger.error(
      details,
      `SePay webhook: ${ref}: ${outcome}, money received but not applied: reconcile or refund it`,
    );
  }

  private logSettled(ref: string, result: ConfirmOutcome): void {
    switch (result.outcome) {
      case 'paid_twice':
        this.logger.error(
          `SePay webhook: ${ref}: payment ${result.paymentId} paid, but booking ${result.bookingId} ` +
            `was already paid by payment ${result.paidPaymentId}: REFUND_REQUIRED, refund it by hand`,
        );
        return;
      case 'confirmed':
        this.logger.log(
          `SePay webhook: ${ref}: payment ${result.paymentId} SUCCESS, booking ` +
            `${result.bookingId} CONFIRMED${result.reclaimed ? ' after taking its seats back' : ''}, ` +
            `${result.ticketIds.length} ticket(s)`,
        );
        return;
      case 'needs_review':
        this.logger.warn(
          `SePay webhook: ${ref}: payment ${result.paymentId} SUCCESS, booking ` +
            `${result.bookingId} NEEDS_REVIEW (${result.problem.reason}), ` +
            `${result.releasedSeatIds.length} of its own HELD seat(s) released`,
        );
        return;
      default:
        return;
    }
  }
}

/** The transfer in `settlePayment`'s terms. Only ever built for an incoming transfer. */
export function sepayReport(webhook: SepayWebhook): PaymentReport {
  return {
    amount: String(webhook.transferAmount),
    paid: true,
    responseCode: null,
    transactionStatus: null,
    bankCode: webhook.gateway ? webhook.gateway.slice(0, LOG_VALUE_MAX) : null,
    transactionNo: String(webhook.id),
    raw: webhook as Prisma.InputJsonObject,
  };
}

/** The ledger outcome of what `settlePayment` did with an incoming transfer. */
function outcomeOf(result: ConfirmOutcome): SepayTransactionOutcome {
  if (SETTLED.has(result.outcome)) return SepayTransactionOutcome.SETTLED;
  switch (result.outcome) {
    case 'not_found':
      return SepayTransactionOutcome.UNKNOWN_REFERENCE;
    case 'invalid_amount':
      return SepayTransactionOutcome.AMOUNT_MISMATCH;
    case 'already_processed':
      return SepayTransactionOutcome.DUPLICATE_TRANSFER;
    default:
      // `failed` needs `paid: false`, which a SePay report never has: the transaction rolls back.
      throw new Error(`settlePayment answered ${result.outcome} for a SePay transfer`);
  }
}
