import { Module } from '@nestjs/common';
import { PaymentsWorkerModule } from '../payment/payments-worker.module';
import { RealtimeWorkerModule } from '../realtime/realtime.module';
import {
  BookingExpiryProcessor,
  DEFAULT_SWEEP_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
} from './booking-expiry.processor';
import { BookingExpiryService } from './booking-expiry.service';

/**
 * Booking jobs of the worker process: hold expiry and the sweep (which announce released seats
 * through the Redis emitter). No HTTP controller. The expiry asks VNPay about an unfinished
 * payment before giving a booking's seats up (querydr, ROADMAP 3.7), hence `PaymentsWorkerModule`.
 */
@Module({
  imports: [RealtimeWorkerModule, PaymentsWorkerModule],
  providers: [
    BookingExpiryService,
    BookingExpiryProcessor,
    { provide: SWEEP_INTERVAL_MS, useValue: DEFAULT_SWEEP_INTERVAL_MS },
  ],
  exports: [BookingExpiryService],
})
export class BookingsWorkerModule {}
