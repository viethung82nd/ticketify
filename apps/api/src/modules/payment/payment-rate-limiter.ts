import { HttpStatus, Injectable } from '@nestjs/common';
import { PaymentErrorCode } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AppConfig } from '../../config/app-config.service';

export const paymentCreateRateKey = (userId: string): string => `rl:payment:user:${userId}`;
export const paymentReturnRateKey = (ip: string): string => `rl:payment-return:ip:${ip}`;

/**
 * Budgets of the payment endpoints (RateLimitService.hit: fixed window, fail-open), counted before
 * anything else the request does, so a refused request costs no database work:
 * - `POST /payments/vnpay`: `PAYMENT_RATE_LIMIT_MAX` per user;
 * - `GET /payments/vnpay/return` (public): `PAYMENT_RETURN_RATE_LIMIT_MAX` per client IP.
 * Both use the window `PAYMENT_RATE_LIMIT_WINDOW_SECONDS`.
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

  /** Counts one result-page check; `429 TOO_MANY_ATTEMPTS` once the IP's budget is spent. */
  consumeReturn(ip: string): Promise<void> {
    return this.consume(paymentReturnRateKey(ip), this.config.get('PAYMENT_RETURN_RATE_LIMIT_MAX'));
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
