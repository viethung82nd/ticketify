import { Injectable, Logger } from '@nestjs/common';
import { ClockService } from '../../infra/clock/clock.service';
import { SQLSTATE, sqlStateOf } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TicketCodes } from '../payment/seat-settlement';
import { VnpayQuerydrClient } from '../payment/vnpay/vnpay-querydr.client';
import { QuerydrVerdict } from '../payment/vnpay/vnpay-querydr';
import { SeatEvents } from '../realtime/seat-events';
import {
  expireBooking,
  type ExpireOutcome,
  type ExpireOutcomeKind,
  type PaidQuerydr,
} from './expire-booking';

/** Bookings one sweep round looks at (ROADMAP 2.8). */
export const SWEEP_BATCH_SIZE = 100;
/** A full round is followed at once by another, up to this many per sweep job. */
export const SWEEP_MAX_ROUNDS = 10;

/**
 * Interactive-transaction limits of one expiry. The booking lock never waits (SKIP LOCKED); the
 * seat locks can, behind a hold (milliseconds) or a showtime cancel.
 */
const EXPIRE_TX = { maxWait: 5_000, timeout: 10_000 } as const;

/**
 * Longest one expiry waits for a row lock (`SET LOCAL lock_timeout`, worker transactions only).
 * The booking's seats are normally locked for milliseconds (a hold, a showtime cancel; from
 * week 12 a payment confirmation), so a longer wait means another session is stuck. Past it
 * Postgres aborts the statement with 55P03 and the transaction rolls back: the booking is "busy"
 * and is tried again later (job: BullMQ retry with its backoff; sweep: the next sweep). Without
 * it a job waits as long as the other session holds the lock, and so would worker shutdown.
 * Not set for holds: they never wait on a lock (NOWAIT).
 */
export const WORKER_LOCK_TIMEOUT_MS = 3_000;

/**
 * Most payment attempts of one booking the expiry asks VNPay about, newest first (ROADMAP 3.7).
 * A booking normally has one; it gets another every time the customer starts the payment again
 * (`POST /payments/vnpay`), and any of them could be the one that was paid. The bound keeps one
 * expiry to a few HTTP calls; past it the oldest attempts are left to their IPN, with a warning.
 */
export const QUERYDR_MAX_ATTEMPTS = 5;

/** A worker statement gave up waiting for a lock after `WORKER_LOCK_TIMEOUT_MS` (55P03). */
export const isLockTimeout = (error: unknown): boolean =>
  sqlStateOf(error) === SQLSTATE.lockNotAvailable;

export interface SweepReport {
  /** Overdue bookings each round found (a full round of 100 is followed by another). */
  batches: number[];
  outcomes: Record<ExpireOutcomeKind, number>;
  /** Seats locked by another session past `WORKER_LOCK_TIMEOUT_MS`; left for the next sweep. */
  busy: number;
  /** Bookings whose expiry threw for another reason; logged and left for the next sweep. */
  failed: number;
}

/**
 * Runs `expireBooking` in its own transaction, for one booking (`expire-booking` job) or for
 * every overdue booking (sweep, the safety net when a job was lost). Worker only.
 */
@Injectable()
export class BookingExpiryService {
  private readonly logger = new Logger(BookingExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly seatEvents: SeatEvents,
    private readonly querydr: VnpayQuerydrClient,
    private readonly ticketCodes: TicketCodes,
  ) {}

  /**
   * Expires one booking in its own transaction. Once that has committed, announces what changed
   * (best-effort): the seats a real expiry gave back (`seat:released`), or the seats a payment
   * found by querydr sold (`seat:sold`) or released on its way to review. `noop`, `skipped`,
   * `early` and a rolled-back transaction send nothing.
   *
   * Before the transaction, and only outside it (PLAN §4), VNPay is asked about every payment
   * attempt still PENDING: an answer that says "paid" is handed to the transaction, which checks
   * it against the locked rows before acting on it.
   */
  async expire(bookingId: string): Promise<ExpireOutcome> {
    const paid = await this.askVnpay(bookingId);
    const result = await this.prisma.$transaction(async (tx) => {
      // set_config(…, true) is SET LOCAL: it ends with this transaction.
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${WORKER_LOCK_TIMEOUT_MS}ms`}, true)`;
      return expireBooking(tx, bookingId, this.clock.now(), {
        paid,
        ticketCode: () => this.ticketCodes.next(),
      });
    }, EXPIRE_TX);
    if (result.outcome === 'expired') {
      this.seatEvents.released(result.showtimeId, result.releasedSeatIds);
    }
    if (result.outcome === 'paid') this.announcePaid(bookingId, result);
    return result;
  }

  /**
   * Asks VNPay about the booking's unfinished payment attempts (querydr, ROADMAP 3.7) and returns
   * the first one it reports paid, newest attempt first. Runs **outside** any transaction and
   * takes no lock: everything read here is checked again under the locks of `expireBooking`.
   *
   * Returns `null` — and the booking then expires exactly as it did before 3.7 — when the booking
   * is not due, when it has no PENDING attempt, when the merchant settings are missing, and for
   * every answer that is not a clear "paid" (including a timeout or a network error, which
   * `VnpayQuerydrClient` turns into `unknown` rather than throwing).
   */
  private async askVnpay(bookingId: string): Promise<PaidQuerydr | null> {
    if (!this.querydr.configured) return null;
    const now = this.clock.now();
    // No lock and no FOR UPDATE: a snapshot, only to decide which attempts are worth asking about.
    const rows = await this.prisma.$queryRaw<
      { id: string; txn_ref: string; created_at: Date; code: string; attempts: number }[]
    >`
      SELECT p.id, p.txn_ref, p.created_at, b.code,
             count(*) OVER ()::int AS attempts
      FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.booking_id = ${bookingId}::uuid AND p.status = 'PENDING'
        AND b.status = 'PENDING' AND b.hold_until <= ${now}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${QUERYDR_MAX_ATTEMPTS}`;
    if (rows.length === 0) return null;
    const attempts = rows[0]?.attempts ?? rows.length;
    if (attempts > QUERYDR_MAX_ATTEMPTS) {
      this.logger.warn(
        `Booking ${bookingId} has ${attempts} PENDING payment attempts; querydr asks about the ` +
          `${QUERYDR_MAX_ATTEMPTS} newest, the rest are left to their IPN`,
      );
    }

    for (const row of rows) {
      const answer = await this.querydr.lookUp({
        txnRef: row.txn_ref,
        paymentCreatedAt: row.created_at,
        orderInfo: `Truy van thanh toan ve ${row.code}`,
        now,
      });
      if (answer.verdict === QuerydrVerdict.PAID) {
        this.logger.warn(
          `Booking ${bookingId} is past holdUntil but querydr reports payment ${row.id} ` +
            `(vnp_TxnRef ${row.txn_ref}) paid: recording it instead of expiring`,
        );
        return { paymentId: row.id, txnRef: row.txn_ref, params: answer.params };
      }
    }
    return null;
  }

  /** Seat events of a payment the expiry found with querydr; same rules as the IPN's. */
  private announcePaid(bookingId: string, result: ExpireOutcome & { outcome: 'paid' }): void {
    const { confirmation } = result;
    if (confirmation.outcome === 'confirmed') {
      this.seatEvents.sold(confirmation.showtimeId, confirmation.seatIds);
      this.logger.log(
        `Booking ${bookingId}: querydr found payment ${result.paymentId} paid; CONFIRMED` +
          `${confirmation.reclaimed ? ' after taking its seats back' : ''}, ` +
          `${confirmation.ticketIds.length} ticket(s)`,
      );
      return;
    }
    if (confirmation.outcome === 'needs_review') {
      this.seatEvents.released(confirmation.showtimeId, confirmation.releasedSeatIds);
      this.logger.warn(
        `Booking ${bookingId}: querydr found payment ${result.paymentId} paid, but the seats were ` +
          `gone (${confirmation.problem.reason}): NEEDS_REVIEW, refund by hand`,
      );
      return;
    }
    this.logger.error(
      `Booking ${bookingId}: querydr found payment ${result.paymentId} paid, but payment ` +
        `${confirmation.outcome === 'paid_twice' ? confirmation.paidPaymentId : '?'} had already ` +
        `paid it: REFUND_REQUIRED, refund it by hand`,
    );
  }

  /**
   * Expires every booking still PENDING past its holdUntil, oldest first, 100 per round. The
   * select takes no lock: `expireBooking` locks each booking with SKIP LOCKED, so a booking a job
   * is expiring right now comes back `skipped`, one already done comes back `noop`. One failing
   * or busy booking never stops the others; it is logged and excluded from the following rounds.
   */
  async sweep(): Promise<SweepReport> {
    const report: SweepReport = {
      batches: [],
      outcomes: { expired: 0, skipped: 0, noop: 0, early: 0, paid: 0 },
      busy: 0,
      failed: 0,
    };
    // Not done by this job (skipped: in another transaction; busy: seats locked; failed: see the log).
    const leftOver: string[] = [];

    while (report.batches.length < SWEEP_MAX_ROUNDS) {
      const ids = await this.overdue(leftOver);
      report.batches.push(ids.length);
      for (const id of ids) {
        try {
          const result = await this.expire(id);
          report.outcomes[result.outcome] += 1;
          // `expired`, `noop` and `paid` are done with; `skipped` and `early` are for a later round.
          if (result.outcome === 'skipped' || result.outcome === 'early') leftOver.push(id);
        } catch (error) {
          leftOver.push(id);
          if (isLockTimeout(error)) {
            report.busy += 1;
            this.logger.warn(
              `Sweep: booking ${id} busy (seats locked over ${WORKER_LOCK_TIMEOUT_MS} ms), next sweep`,
            );
            continue;
          }
          report.failed += 1;
          this.logger.error(
            `Sweep could not expire booking ${id}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      if (ids.length < SWEEP_BATCH_SIZE) break;
    }
    return report;
  }

  private async overdue(exclude: readonly string[]): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM bookings
      WHERE status = 'PENDING' AND hold_until <= ${this.clock.now()}
        AND NOT (id = ANY(${exclude}::uuid[]))
      ORDER BY hold_until
      LIMIT ${SWEEP_BATCH_SIZE}`;
    return rows.map((row) => row.id);
  }
}
