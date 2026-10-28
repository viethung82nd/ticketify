import { HttpStatus, Injectable } from '@nestjs/common';
import { BookingErrorCode } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AppConfig } from '../../config/app-config.service';

export const bookingRateKey = (userId: string): string => `rl:booking:user:${userId}`;

/**
 * `POST /bookings` budget per user: `BOOKING_RATE_LIMIT_MAX` requests per fixed window of
 * `BOOKING_RATE_LIMIT_WINDOW_SECONDS` (RateLimitService.hit: INCR + EXPIRE NX). Counted before
 * the hold transaction — and before the Idempotency-Key lookup — so a refused request costs no
 * database work. Retries with the same key count too. Fail-open like the login limit.
 */
@Injectable()
export class BookingRateLimiter {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly config: AppConfig,
  ) {}

  /** Counts one request; throws `429 TOO_MANY_ATTEMPTS` once the user's budget is spent. */
  async consume(userId: string): Promise<void> {
    const result = await this.rateLimit.hit(
      bookingRateKey(userId),
      this.config.get('BOOKING_RATE_LIMIT_MAX'),
      this.config.get('BOOKING_RATE_LIMIT_WINDOW_SECONDS'),
    );
    if (result.allowed) return;
    throw apiException(
      HttpStatus.TOO_MANY_REQUESTS,
      BookingErrorCode.TOO_MANY_ATTEMPTS,
      'Too many booking attempts, please try again later',
      { retryAfterSeconds: result.retryAfterSeconds },
    );
  }
}
