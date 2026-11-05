import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { pinoLoggerModule } from './config/logger.module';
import { ClockModule } from './infra/clock/clock.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.module';
import { BookingsWorkerModule } from './modules/bookings/bookings-worker.module';
import { DeliveryWorkerModule } from './modules/delivery/delivery-worker.module';

/**
 * Root module of the worker process (`main.worker.ts`): the same infrastructure as the API
 * (config, logger, clock, Prisma, Redis, BullMQ) plus job processors and the outbox relay, and no
 * HTTP controller.
 */
@Module({
  imports: [
    AppConfigModule,
    pinoLoggerModule(),
    ClockModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    BookingsWorkerModule,
    DeliveryWorkerModule,
  ],
})
export class WorkerModule {}
