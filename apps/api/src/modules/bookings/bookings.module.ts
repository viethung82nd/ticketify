import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingsController } from './bookings.controller';
import { ExpirationScheduler } from './expiration-scheduler';

/** Seat holds and bookings (ROADMAP phase 2). */
@Module({
  controllers: [BookingsController],
  providers: [BookingService, ExpirationScheduler],
  exports: [BookingService],
})
export class BookingsModule {}
