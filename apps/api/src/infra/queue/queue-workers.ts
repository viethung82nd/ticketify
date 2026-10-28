import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type Processor, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service';
import { closeConnection, createQueueConnection, settlesWithin } from './queue-connection';

/** How long shutdown waits for running jobs before giving up on them (ROADMAP 2.6). */
export const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface StartWorkerOptions {
  concurrency: number;
}

interface RunningWorker {
  worker: Worker;
  connection: Redis;
}

/**
 * Starts and stops BullMQ workers. Only the worker process (`main.worker.ts`) starts any: the API
 * gets this provider too (same QueueModule) but never calls `start`, so it opens no connection.
 */
@Injectable()
export class QueueWorkers implements OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkers.name);
  private readonly running: RunningWorker[] = [];
  private closing: Promise<boolean> | null = null;

  constructor(private readonly config: AppConfig) {}

  start<Data, Result>(
    queueName: string,
    processor: Processor<Data, Result>,
    options: StartWorkerOptions,
  ): Worker<Data, Result> {
    if (this.closing) throw new Error('Workers are shutting down');
    const connection = createQueueConnection(this.config.get('REDIS_URL'), 'worker');
    const worker = new Worker<Data, Result>(queueName, processor, {
      connection,
      concurrency: options.concurrency,
    });
    worker.on('error', (error: Error) =>
      this.logger.error(`Worker ${queueName}: ${error.message}`),
    );
    worker.on('failed', (job, error) =>
      this.logger.warn(
        `Job ${job?.name ?? '?'} ${job?.id ?? '?'} failed (attempt ${job?.attemptsMade ?? '?'}): ${error.message}`,
      ),
    );
    this.running.push({ worker, connection });
    this.logger.log(`Worker started on queue ${queueName} (concurrency ${options.concurrency})`);
    return worker;
  }

  /**
   * Stops every worker: no new job is fetched, running jobs get up to `timeoutMs` to finish.
   * Resolves `true` when they all did. On timeout the connections are dropped: an unfinished job
   * keeps its lock in Redis until it expires, then the stalled check of a worker puts it back in
   * the queue. Its database transaction never committed, so nothing is left half done.
   */
  closeAll(timeoutMs = WORKER_SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
    this.closing ??= this.closeWorkers(timeoutMs);
    return this.closing;
  }

  /** Safety net for `app.close()` without an explicit `closeAll()` (tests, API process). */
  async onModuleDestroy(): Promise<void> {
    await this.closeAll();
  }

  private async closeWorkers(timeoutMs: number): Promise<boolean> {
    const results = await Promise.all(
      this.running.map(async ({ worker, connection }) => {
        const finished = await settlesWithin(
          worker.close().then(
            () => true,
            () => false,
          ),
          timeoutMs,
        );
        if (!finished) {
          this.logger.warn(
            `Worker ${worker.name}: jobs still running after ${timeoutMs}ms; ` +
              'they return to the queue once their lock expires',
          );
          worker.cancelAllJobs('shutdown');
          connection.disconnect();
          return false;
        }
        await closeConnection(connection);
        return true;
      }),
    );
    return results.every(Boolean);
  }
}
