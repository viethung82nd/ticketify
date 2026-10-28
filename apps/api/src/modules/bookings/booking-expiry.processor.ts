import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import {
  BOOKING_QUEUE,
  BookingJob,
  type ExpireBookingJobData,
} from '../../infra/queue/booking-queue';
import { BookingQueueProducer } from '../../infra/queue/booking-queue.producer';
import { QueueWorkers } from '../../infra/queue/queue-workers';
import { BookingExpiryService, type SweepReport } from './booking-expiry.service';
import type { ExpireOutcome } from './expire-booking';

/** Jobs of the `bookings` queue one worker process runs at the same time (ROADMAP 2.6). */
export const BOOKING_WORKER_CONCURRENCY = 5;

/** Milliseconds between two sweeps; 0 disables the scheduler (integration tests). */
export const SWEEP_INTERVAL_MS = Symbol('SWEEP_INTERVAL_MS');
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Worker side of the `bookings` queue: runs `expire-booking` jobs and the per-minute sweep.
 *
 * The sweep is a BullMQ job scheduler rather than `@nestjs/schedule`: the schedule lives in Redis,
 * so with several worker processes each tick is ONE job taken by ONE worker (an in-process cron
 * would fire in every process), it survives restarts, and it needs no extra dependency.
 */
@Injectable()
export class BookingExpiryProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(BookingExpiryProcessor.name);

  constructor(
    private readonly expiry: BookingExpiryService,
    private readonly workers: QueueWorkers,
    private readonly producer: BookingQueueProducer,
    @Inject(SWEEP_INTERVAL_MS) private readonly sweepIntervalMs: number,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.sweepIntervalMs > 0) {
      await this.producer.queue.upsertJobScheduler(
        BookingJob.SWEEP,
        { every: this.sweepIntervalMs },
        { name: BookingJob.SWEEP, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    } else {
      await this.producer.queue.removeJobScheduler(BookingJob.SWEEP);
    }
    this.workers.start(BOOKING_QUEUE, (job, token) => this.process(job, token), {
      concurrency: BOOKING_WORKER_CONCURRENCY,
    });
  }

  async process(job: Job, token?: string): Promise<ExpireOutcome | SweepReport> {
    switch (job.name) {
      case BookingJob.EXPIRE:
        return this.expireJob(job as Job<ExpireBookingJobData>, token);
      case BookingJob.SWEEP: {
        const report = await this.expiry.sweep();
        if (report.batches[0]) this.logger.log(`Sweep: ${JSON.stringify(report)}`);
        return report;
      }
      default:
        throw new UnrecoverableError(`Unknown job ${job.name}`);
    }
  }

  private async expireJob(
    job: Job<ExpireBookingJobData>,
    token: string | undefined,
  ): Promise<ExpireOutcome> {
    const { bookingId } = job.data;
    const result = await this.expiry.expire(bookingId);
    if (result.outcome === 'early') {
      // Same job, run again at holdUntil (a new job with this id would be dropped as a duplicate).
      await job.moveToDelayed(result.holdUntil.getTime(), token);
      throw new DelayedError();
    }
    this.logger.debug(`expire-booking ${bookingId}: ${JSON.stringify(result)}`);
    return result;
  }
}
