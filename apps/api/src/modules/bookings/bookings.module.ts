import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { BookingExpirationQueue } from './booking-expiration-queue';
import { BookingRateLimiter } from './booking-rate-limiter';
import { BookingViews } from './booking-views';
import { BookingService } from './booking.service';
import { BookingsController, MyBookingsController } from './bookings.controller';

/** Seat holds and bookings (ROADMAP phase 2), HTTP side. Jobs run in BookingsWorkerModule. */
@Module({
  controllers: [BookingsController, MyBookingsController],
  providers: [
    BookingService,
    BookingViews,
    BookingExpirationQueue,
    RateLimitService,
    BookingRateLimiter,
  ],
  exports: [BookingService],
})
export class BookingsModule {}
