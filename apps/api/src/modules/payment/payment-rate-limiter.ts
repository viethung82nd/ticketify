import { HttpStatus, Injectable } from '@nestjs/common';
import { PaymentErrorCode } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AppConfig } from '../../config/app-config.service';

export const paymentCreateRateKey = (userId: string): string => `rl:payment:user:${userId}`;

/**
 * `POST /payments/vnpay` budget per user: `PAYMENT_RATE_LIMIT_MAX` requests per fixed window of
 * `PAYMENT_RATE_LIMIT_WINDOW_SECONDS` (RateLimitService.hit, fail-open). Counted before anything
 * else the request does, so a refused request costs no database work.
 */
@Injectable()
export class PaymentRateLimiter {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly config: AppConfig,
  ) {}

  /** Counts one payment attempt; `429 TOO_MANY_ATTEMPTS` once the user's budget is spent. */
  consumeCreate(userId: string): Promise<void> {
    return this.consume(paymentCreateRateKey(userId), this.config.get('PAYMENT_RATE_LIMIT_MAX'));
  }

  private async consume(key: string, max: number): Promise<void> {
    const result = await this.rateLimit.hit(
      key,
      max,
      this.config.get('PAYMENT_RATE_LIMIT_WINDOW_SECONDS'),
    );
    if (result.allowed) return;
    throw apiException(
      HttpStatus.TOO_MANY_REQUESTS,
      PaymentErrorCode.TOO_MANY_ATTEMPTS,
      'Too many payment requests, please try again later',
      { retryAfterSeconds: result.retryAfterSeconds },
    );
  }
}
