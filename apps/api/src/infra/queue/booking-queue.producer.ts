import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service';
import { waitUntilReady } from '../redis/redis.module';
import {
  BOOKING_QUEUE,
  BookingJob,
  type ExpireBookingJobData,
  expireBookingJobId,
} from './booking-queue';
import { closeConnection, createQueueConnection } from './queue-connection';

/** Longest a hold request waits for Redis to accept a job before giving up on it. */
const ENQUEUE_TIMEOUT_MS = 1_000;

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  // A failed run (DB down...) is retried; after the last attempt the sweep is the safety net.
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: { count: 1_000 },
};

/**
 * Adds jobs to the `bookings` queue. Used by the API (after a hold commits) and by the worker
 * (job scheduler of the sweep). Owns its own Redis connection (see `createQueueConnection`).
 */
@Injectable()
export class BookingQueueProducer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BookingQueueProducer.name);
  private readonly connection: Redis;
  readonly queue: Queue;

  constructor(config: AppConfig) {
    this.connection = createQueueConnection(config.get('REDIS_URL'), 'producer');
    this.queue = new Queue(BOOKING_QUEUE, {
      connection: this.connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    // Without a listener an 'error' event would crash the process.
    this.queue.on('error', (error: Error) => this.logger.warn(`Queue error: ${error.message}`));
  }

  /** Same boot behaviour as the shared client: wait up to 3 s for Redis, then start anyway. */
  async onModuleInit(): Promise<void> {
    await waitUntilReady(this.connection);
  }

  /**
   * Schedules `expire-booking` for one booking, `delayMs` from now. Adding it again for the same
   * booking is a no-op (fixed job id). Rejects if Redis does not take the job within 1 s.
   */
  async enqueueExpiry(bookingId: string, delayMs: number): Promise<void> {
    const data: ExpireBookingJobData = { bookingId };
    await withTimeout(
      this.queue.add(BookingJob.EXPIRE, data, {
        jobId: expireBookingJobId(bookingId),
        delay: delayMs,
      }),
      ENQUEUE_TIMEOUT_MS,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await closeConnection(this.connection);
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
