import { Module } from '@nestjs/common';
import { BookingExpirationQueue } from './booking-expiration-queue';
import { BookingService } from './booking.service';
import { BookingsController } from './bookings.controller';

/** Seat holds and bookings (ROADMAP phase 2), HTTP side. Jobs run in the worker process. */
@Module({
  controllers: [BookingsController],
  providers: [BookingService, BookingExpirationQueue],
  exports: [BookingService],
})
export class BookingsModule {}
