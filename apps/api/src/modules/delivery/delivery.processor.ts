import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import type { z } from 'zod';
import { seatsReleasedPayloadSchema } from '../../infra/outbox/outbox-payloads';
import {
  DELIVERY_QUEUE,
  DeliveryAction,
  type DeliveryJobData,
} from '../../infra/queue/delivery-queue';
import { QueueWorkers } from '../../infra/queue/queue-workers';
import { SeatEvents } from '../realtime/seat-events';

/** Delivery jobs one worker process runs at the same time. */
export const DELIVERY_WORKER_CONCURRENCY = 5;

/**
 * Worker side of the `delivery` queue (PLAN §7): every step that happens after a payment
 * transaction committed. Fed by the outbox relay, so each step must be idempotent — it may run
 * again after a crash or a lost acknowledgement.
 *
 * Steps are added by the tasks that own them: `broadcast-seats` here (4.1), `notify` in 4.2,
 * `generate-pdf` in 4.4–4.5, `send-email` in 4.6.
 */
@Injectable()
export class DeliveryProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeliveryProcessor.name);

  constructor(
    private readonly workers: QueueWorkers,
    private readonly seatEvents: SeatEvents,
  ) {}

  onApplicationBootstrap(): void {
    this.workers.start<DeliveryJobData, void>(DELIVERY_QUEUE, (job) => this.process(job), {
      concurrency: DELIVERY_WORKER_CONCURRENCY,
    });
  }

  async process(job: Job<DeliveryJobData>): Promise<void> {
    switch (job.name) {
      case DeliveryAction.BROADCAST_SEATS:
        return this.broadcastSeats(job.data);
      default:
        // Nothing retries an unknown action: this build cannot grow a handler mid-job.
        throw new UnrecoverableError(`Unknown delivery action ${job.name}`);
    }
  }

  /**
   * `seats.released` → `seat:released` in room `showtime:{id}` (best-effort, never throws).
   *
   * The flow that released the seats also sends the event itself, right after its own commit, so
   * a browser sees the seats free within milliseconds; this one is the durable copy, which
   * arrives even if that process died first. A client may therefore get `seat:released` twice for
   * the same seats — applying it twice is the same as applying it once (ROADMAP "Đã chốt").
   */
  private broadcastSeats(data: DeliveryJobData): Promise<void> {
    const payload = this.parse(seatsReleasedPayloadSchema, data);
    this.seatEvents.released(payload.showtimeId, payload.seatIds);
    return Promise.resolve();
  }

  /** Parses a payload, or gives up on the job for good (a bad row is not a transient failure). */
  private parse<T extends z.ZodType>(schema: T, data: DeliveryJobData): z.infer<T> {
    const result = schema.safeParse(data.payload);
    if (!result.success) {
      const reason = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      this.logger.error(
        `Outbox event ${data.eventId} (${data.type}) has an unusable payload: ${reason}`,
      );
      throw new UnrecoverableError(`Outbox event ${data.eventId} has an unusable payload`);
    }
    return result.data;
  }
}
