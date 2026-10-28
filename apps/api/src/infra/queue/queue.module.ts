import { Global, Module } from '@nestjs/common';
import { BookingQueueProducer } from './booking-queue.producer';
import { QueueWorkers } from './queue-workers';

/**
 * BullMQ, shared by both entry points: the API (`main.ts`) only adds jobs through
 * `BookingQueueProducer`; the worker (`main.worker.ts`) also starts workers via `QueueWorkers`.
 */
@Global()
@Module({
  providers: [BookingQueueProducer, QueueWorkers],
  exports: [BookingQueueProducer, QueueWorkers],
})
export class QueueModule {}
