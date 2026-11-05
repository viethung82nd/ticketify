import { Module } from '@nestjs/common';
import {
  DEFAULT_OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_POLL_INTERVAL_MS,
  OutboxRelay,
} from '../../infra/outbox/outbox-relay.service';
import { DeliveryQueueProducer } from '../../infra/queue/delivery-queue.producer';
import { NotificationsWorkerModule } from '../notifications/notifications.module';
import { RealtimeWorkerModule } from '../realtime/realtime.module';
import { TicketsWorkerModule } from '../tickets/tickets.module';
import { BookingDelivery } from './booking-delivery';
import { DeliveryProcessor } from './delivery.processor';

/**
 * Ticket delivery in the worker process (ROADMAP phase 4): the outbox relay and the `delivery`
 * queue's processor. Not imported by the API — only the worker turns outbox rows into jobs.
 */
@Module({
  imports: [RealtimeWorkerModule, NotificationsWorkerModule, TicketsWorkerModule],
  providers: [
    DeliveryQueueProducer,
    OutboxRelay,
    DeliveryProcessor,
    BookingDelivery,
    { provide: OUTBOX_POLL_INTERVAL_MS, useValue: DEFAULT_OUTBOX_POLL_INTERVAL_MS },
  ],
  exports: [OutboxRelay],
})
export class DeliveryWorkerModule {}
