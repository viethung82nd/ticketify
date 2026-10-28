import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { QueueWorkers, WORKER_SHUTDOWN_TIMEOUT_MS } from './infra/queue/queue-workers';
import { WorkerModule } from './worker.module';

/**
 * Worker process: BullMQ jobs only, no HTTP server (`createApplicationContext`).
 *
 * Shutdown is ordered by hand instead of `enableShutdownHooks()`, because Nest would close the
 * modules in its own order and could disconnect Prisma under a running job:
 * 1. stop the workers — no new job, running jobs get up to 10 s to finish;
 * 2. close the application — Prisma (Postgres) then Redis and the queue connections.
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
    logger.log(`${signal}: stopping workers (up to ${WORKER_SHUTDOWN_TIMEOUT_MS} ms)`, 'Worker');
    void app
      .get(QueueWorkers)
      .closeAll(WORKER_SHUTDOWN_TIMEOUT_MS)
      .then(async (clean) => {
        if (!clean) logger.warn('Some jobs did not finish; they will be retried', 'Worker');
        await app.close();
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
