import { Injectable, Logger } from '@nestjs/common';
import { ClockService } from '../../infra/clock/clock.service';
import { SQLSTATE, sqlStateOf } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { expireBooking, type ExpireOutcome, type ExpireOutcomeKind } from './expire-booking';

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
  ) {}

  expire(bookingId: string): Promise<ExpireOutcome> {
    // TODO(3.7): querydr ngoài transaction — read the booking's PENDING payment here, outside any
    // transaction, ask VNPay about it, then open the transaction below with the answer.
    return this.prisma.$transaction(async (tx) => {
      // set_config(…, true) is SET LOCAL: it ends with this transaction.
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${WORKER_LOCK_TIMEOUT_MS}ms`}, true)`;
      return expireBooking(tx, bookingId, this.clock.now());
    }, EXPIRE_TX);
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
      outcomes: { expired: 0, skipped: 0, noop: 0, early: 0 },
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
          if (result.outcome !== 'expired' && result.outcome !== 'noop') leftOver.push(id);
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
