import { Injectable, Logger } from '@nestjs/common';
import { ClockService } from '../../infra/clock/clock.service';
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

export interface SweepReport {
  /** Overdue bookings each round found (a full round of 100 is followed by another). */
  batches: number[];
  outcomes: Record<ExpireOutcomeKind, number>;
  /** Bookings whose expiry threw; logged and left for the next sweep. */
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
    return this.prisma.$transaction(
      (tx) => expireBooking(tx, bookingId, this.clock.now()),
      EXPIRE_TX,
    );
  }

  /**
   * Expires every booking still PENDING past its holdUntil, oldest first, 100 per round. The
   * select takes no lock: `expireBooking` locks each booking with SKIP LOCKED, so a booking a job
   * is expiring right now comes back `skipped`, one already done comes back `noop`. One failing
   * booking never stops the others; it is logged and excluded from the following rounds.
   */
  async sweep(): Promise<SweepReport> {
    const report: SweepReport = {
      batches: [],
      outcomes: { expired: 0, skipped: 0, noop: 0, early: 0 },
      failed: 0,
    };
    // Not done by this job (skipped: in another transaction; failed: see the log).
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
          report.failed += 1;
          leftOver.push(id);
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
