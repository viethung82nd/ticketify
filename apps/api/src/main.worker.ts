import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import {
  QueueWorkers,
  type RunningJob,
  WORKER_SHUTDOWN_GRACE_MS,
} from './infra/queue/queue-workers';
import { WorkerModule } from './worker.module';

const describeJob = (job: RunningJob): string =>
  `${job.name} ${job.id ?? '?'}${job.bookingId ? ` (booking ${job.bookingId})` : ''}`;

/**
 * Worker process: BullMQ jobs only, no HTTP server (`createApplicationContext`).
 *
 * Shutdown is ordered by hand instead of `enableShutdownHooks()`, because Nest would close the
 * modules in its own order and could disconnect Prisma under a running job:
 * 1. stop the workers — no new job, running jobs get time to finish;
 * 2. close the application — Prisma (Postgres) then Redis and the queue connections;
 * 3. exit 0.
 * Everything above has a hard deadline of `WORKER_SHUTDOWN_GRACE_MS` (10 s) from the signal. Past
 * it the process logs the jobs still running and exits with code 1 without waiting for
 * `app.close()`, which would otherwise wait for a query that is stuck (ROADMAP 2.6). That is safe:
 * - Postgres rolls back a transaction that never committed once its connection is gone, so an
 *   expiry cut short leaves the booking PENDING with its seats HELD, never half done;
 * - the job keeps its lock in Redis until the lock expires, then BullMQ marks it stalled and runs
 *   it again in a worker; `expireBooking` re-checks everything under its row lock (idempotent),
 *   and the per-minute sweep catches the booking anyway.
 * A second signal exits at once.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logger.log('Worker started', 'Worker');

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn(`${signal} again: exiting now`, 'Worker');
      process.exit(1);
    }
    stopping = true;
    const workers = app.get(QueueWorkers);
    logger.log(`${signal}: stopping workers (up to ${WORKER_SHUTDOWN_GRACE_MS} ms)`, 'Worker');

    const deadline = setTimeout(() => {
      const running = workers.runningJobs();
      logger.error(
        `Shutdown took longer than ${WORKER_SHUTDOWN_GRACE_MS} ms; exiting with code 1. ` +
          (running.length > 0
            ? `Still running (rolled back by Postgres, retried by BullMQ): ${running.map(describeJob).join(', ')}`
            : 'No job running; closing the connections hung.'),
        'Worker',
      );
      process.exit(1);
    }, WORKER_SHUTDOWN_GRACE_MS);

    void workers
      .closeAll(WORKER_SHUTDOWN_GRACE_MS)
      .then(async (clean) => {
        if (!clean) logger.warn('Some jobs did not finish; they will be retried', 'Worker');
        await app.close();
        clearTimeout(deadline);
        logger.log('Worker stopped', 'Worker');
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

bootstrap().catch((error: unknown) => {
  // The Nest logger may not exist yet (e.g. invalid env), so print plainly and exit.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
