import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service';
import { waitUntilReady } from '../redis/redis.module';
import {
  DELIVERY_QUEUE,
  type DeliveryAction,
  type DeliveryJobData,
  deliveryJobId,
} from './delivery-queue';
import { closeConnection, createQueueConnection, withTimeout } from './queue-connection';

/** Longest the relay (or a handler chaining the next step) waits for Redis to take the jobs. */
const ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * Delivery is retried far more patiently than a booking job: SMTP and object storage come back
 * on their own, and the work is idempotent (fixed PDF key, `emailSentAt`). Eight attempts with
 * exponential backoff from 2 s span roughly four minutes; past that the job stays in `failed`
 * (kept for inspection) and the event's `outbox_events` row still says what happened.
 */
export const DELIVERY_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { count: 1_000 },
};

/**
 * Adds jobs to the `delivery` queue. Lives in the worker process only (the relay runs there), so
 * the API opens no connection for it.
 */
@Injectable()
export class DeliveryQueueProducer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DeliveryQueueProducer.name);
  private readonly connection: Redis;
  readonly queue: Queue<DeliveryJobData>;

  constructor(config: AppConfig) {
    this.connection = createQueueConnection(config.get('REDIS_URL'), 'producer');
    this.queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, {
      connection: this.connection,
      defaultJobOptions: DELIVERY_JOB_OPTIONS,
    });
    // Without a listener an 'error' event would crash the process.
    this.queue.on('error', (error: Error) => this.logger.warn(`Queue error: ${error.message}`));
  }

  async onModuleInit(): Promise<void> {
    await waitUntilReady(this.connection);
  }

  /**
   * Adds one job per action of one event, in a single round-trip. A job id already in the queue
   * is dropped by BullMQ, so handing the same event over twice adds nothing. Rejects (and adds
   * nothing or only part of the batch — both safe, the ids dedupe) if Redis does not answer in
   * time; the caller leaves the event `PENDING` and tries again.
   */
  async enqueue(data: DeliveryJobData, actions: readonly DeliveryAction[]): Promise<void> {
    if (actions.length === 0) return;
    await withTimeout(
      this.queue.addBulk(
        actions.map((action) => ({
          name: action,
          data,
          opts: { jobId: deliveryJobId(data.eventId, action) },
        })),
      ),
      ENQUEUE_TIMEOUT_MS,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await closeConnection(this.connection);
  }
}
