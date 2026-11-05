import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ClockService } from '../clock/clock.service';
import { PrismaService } from '../prisma/prisma.service';
import { actionsOf, RELAYED_EVENT_TYPES } from '../queue/delivery-queue';
import { DeliveryQueueProducer } from '../queue/delivery-queue.producer';
import {
  claimOutboxBatch,
  markPublished,
  markRetry,
  OUTBOX_BATCH_SIZE,
  reasonOf,
  reclaimStaleClaims,
} from './outbox-relay';

/** Milliseconds between two rounds; 0 disables the loop (tests call `pollOnce` themselves). */
export const OUTBOX_POLL_INTERVAL_MS = Symbol('OUTBOX_POLL_INTERVAL_MS');
export const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 1_000;

/** What one round did. */
export interface RelayReport {
  /** Rows a dead worker had claimed and that went back in the queue. */
  reclaimed: number;
  claimed: number;
  published: number;
  /** Events whose hand-over failed and that will be tried again. */
  retried: number;
  /** Events that used up their attempts: `FAILED`, left for a person. */
  failed: number;
}

const EMPTY_ROUND: RelayReport = {
  reclaimed: 0,
  claimed: 0,
  published: 0,
  retried: 0,
  failed: 0,
};

/**
 * Outbox relay (PLAN §7, ROADMAP 4.1): turns committed `outbox_events` rows into `delivery` jobs.
 * Worker process only.
 *
 * Why a relay at all: the payment transaction cannot enqueue a job, because Redis is not part of
 * its commit. It writes a row instead, and this loop — at least once — hands each row to BullMQ.
 * Everything downstream is therefore idempotent by construction (fixed PDF key, `emailSentAt`,
 * `Notification` per event, `UPDATE ... WHERE status = 'ISSUED'`).
 *
 * One round:
 * 1. put abandoned `PROCESSING` rows back (a worker killed mid-round);
 * 2. claim a batch (`FOR UPDATE SKIP LOCKED`, `attempts + 1`, `locked_at`/`locked_by`);
 * 3. per event, add its jobs (`{eventId}-{action}`, so a repeat adds nothing);
 * 4. `PUBLISHED` for those that made it, `PENDING` with `next_retry_at` + `last_error` for those
 *    that did not — `FAILED` once `OUTBOX_MAX_ATTEMPTS` is reached.
 * A full batch is followed at once by another round, so a backlog drains without waiting.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  /** Names this process in `locked_by`, so a stuck row says who took it. */
  readonly lockedBy = `${hostname()}-${process.pid}`;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private round: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly producer: DeliveryQueueProducer,
    @Inject(OUTBOX_POLL_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('Outbox relay loop disabled (poll interval 0)');
      return;
    }
    this.logger.log(`Outbox relay polling every ${this.intervalMs} ms as ${this.lockedBy}`);
    this.schedule(0);
  }

  /** Stops the loop and waits for the round in flight (it only writes row states). */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.round.catch(() => undefined);
  }

  /**
   * One round. Never throws for a single event: a failed hand-over is recorded on that row and
   * the others continue. A failure of the claim itself (database down) does throw; the loop logs
   * it and tries again on the next tick.
   */
  async pollOnce(): Promise<RelayReport> {
    const now = this.clock.now();
    const report: RelayReport = { ...EMPTY_ROUND };
    report.reclaimed = await reclaimStaleClaims(this.prisma, now);
    if (report.reclaimed > 0) {
      this.logger.warn(`Outbox: ${report.reclaimed} abandoned claim(s) back in the queue`);
    }

    const events = await claimOutboxBatch(this.prisma, {
      now,
      lockedBy: this.lockedBy,
      types: RELAYED_EVENT_TYPES,
    });
    report.claimed = events.length;

    const published: string[] = [];
    for (const event of events) {
      try {
        await this.producer.enqueue(
          {
            eventId: event.id,
            type: event.type,
            aggregateId: event.aggregateId,
            payload: event.payload,
          },
          actionsOf(event.type),
        );
        published.push(event.id);
      } catch (error) {
        const status = await markRetry(this.prisma, event, now, error);
        if (status === 'FAILED') {
          report.failed += 1;
          this.logger.error(
            `Outbox event ${event.id} (${event.type}) given up on after ${event.attempts} ` +
              `attempts: ${reasonOf(error)}`,
          );
        } else {
          report.retried += 1;
          this.logger.warn(
            `Outbox event ${event.id} (${event.type}) not handed over ` +
              `(attempt ${event.attempts}): ${reasonOf(error)}`,
          );
        }
      }
    }
    report.published = await markPublished(this.prisma, published);
    if (report.claimed > 0) this.logger.debug(`Outbox round: ${JSON.stringify(report)}`);
    return report;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.round = this.pollOnce()
        .then((report) => (report.claimed >= OUTBOX_BATCH_SIZE ? 0 : this.intervalMs))
        .catch((error: unknown) => {
          this.logger.warn(`Outbox round failed, retrying: ${reasonOf(error)}`);
          return this.intervalMs;
        })
        .then((next) => this.schedule(next));
    }, delayMs);
    // Never a reason to keep the process alive: BullMQ's workers do that.
    this.timer.unref();
  }
}
