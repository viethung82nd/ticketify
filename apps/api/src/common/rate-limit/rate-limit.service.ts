import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';

export interface RateLimitResult {
  allowed: boolean;
  /** Hits counted in the current window, including this one (0 when Redis is unavailable). */
  count: number;
  /** Seconds until the window resets; 0 when allowed or unknown. */
  retryAfterSeconds: number;
}

/** Upper bound on one Redis round trip so a hung Redis cannot stall requests. */
const REDIS_TIMEOUT_MS = 1_000;

const ALLOW: RateLimitResult = { allowed: true, count: 0, retryAfterSeconds: 0 };

/**
 * Fixed-window counters in Redis: `INCR` + `EXPIRE … NX` (+ `TTL`) in one MULTI.
 *
 * `EXPIRE NX` only sets a TTL when the key has none, so the window starts at the first hit
 * and a key can never be left without expiry even if a previous call died half-way.
 *
 * **Fail-open**: if Redis is down or slow the request is allowed and a warning is logged.
 * Rate limiting is a defence-in-depth layer (passwords are argon2id); refusing every login
 * during a Redis outage would turn a cache incident into a full auth outage.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    try {
      const results = await withTimeout(
        this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec(),
      );
      const [incr, , ttl] = results ?? [];
      if (!incr || incr[0] || !ttl || ttl[0]) {
        throw incr?.[0] ?? ttl?.[0] ?? new Error('MULTI was aborted');
      }
      const count = Number(incr[1]);
      const allowed = count <= limit;
      const remaining = Number(ttl[1]);
      return {
        allowed,
        count,
        retryAfterSeconds: allowed ? 0 : remaining > 0 ? remaining : windowSeconds,
      };
    } catch (error) {
      this.logger.warn(`Rate limit skipped (fail-open) for ${key}: ${messageOf(error)}`);
      return ALLOW;
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await withTimeout(this.redis.del(key));
    } catch (error) {
      this.logger.warn(`Rate limit reset failed for ${key}: ${messageOf(error)}`);
    }
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis timed out after ${REDIS_TIMEOUT_MS}ms`)),
      REDIS_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
