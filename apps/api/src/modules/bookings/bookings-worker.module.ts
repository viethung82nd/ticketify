import { Module } from '@nestjs/common';
import {
  BookingExpiryProcessor,
  DEFAULT_SWEEP_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
} from './booking-expiry.processor';
import { BookingExpiryService } from './booking-expiry.service';

/** Booking jobs of the worker process: hold expiry and the sweep. No HTTP controller. */
@Module({
  providers: [
    BookingExpiryService,
    BookingExpiryProcessor,
    { provide: SWEEP_INTERVAL_MS, useValue: DEFAULT_SWEEP_INTERVAL_MS },
  ],
  exports: [BookingExpiryService],
})
export class BookingsWorkerModule {}
