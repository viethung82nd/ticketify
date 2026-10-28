import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AuthErrorCode } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AppConfig } from '../../config/app-config.service';

/**
 * The per-IP budget is larger than the per-email one: several people can share an IP
 * (NAT, office, campus), while one email belongs to one person.
 */
export const IP_LIMIT_MULTIPLIER = 4;

export const emailKey = (email: string): string =>
  `rl:login:email:${createHash('sha256').update(email).digest('hex')}`;

export const ipKey = (ip: string): string => `rl:login:ip:${ip}`;

/**
 * Login throttling with two fixed-window counters:
 * - per email (key = SHA-256 of the normalized email, so Redis never holds raw emails);
 * - per client IP (`req.ip`, which follows `TRUST_PROXY` behind a reverse proxy).
 *
 * Every attempt is counted *before* the password is checked: counting atomically up front
 * means a burst of parallel guesses cannot slip past the limit. A successful login resets
 * the email counter only.
 */
@Injectable()
export class LoginRateLimiter {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly config: AppConfig,
  ) {}

  /** Counts one attempt; throws `429 TOO_MANY_ATTEMPTS` when either budget is exhausted. */
  async consume(email: string, ip: string): Promise<void> {
    const max = this.config.get('LOGIN_RATE_LIMIT_MAX');
    const window = this.config.get('LOGIN_RATE_LIMIT_WINDOW_SECONDS');
    const [byEmail, byIp] = await Promise.all([
      this.rateLimit.hit(emailKey(email), max, window),
      this.rateLimit.hit(ipKey(ip), max * IP_LIMIT_MULTIPLIER, window),
    ]);
    if (byEmail.allowed && byIp.allowed) return;

    throw apiException(
      HttpStatus.TOO_MANY_REQUESTS,
      AuthErrorCode.TOO_MANY_ATTEMPTS,
      'Too many login attempts, please try again later',
      { retryAfterSeconds: Math.max(byEmail.retryAfterSeconds, byIp.retryAfterSeconds) },
    );
  }

  resetEmail(email: string): Promise<void> {
    return this.rateLimit.reset(emailKey(email));
  }
}
