import { HttpException, HttpStatus } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { FakeRedis } from '../../common/rate-limit/testing/fake-redis';
import { testConfig } from '../../config/testing/test-config';
import { BookingRateLimiter, bookingRateKey } from './booking-rate-limiter';

const USER = '01a17e75-7100-7679-b8b1-000000000001';
const OTHER = '01a17e75-7100-7679-b8b1-000000000002';

/** The 429 a call throws, or `null` when it was allowed. */
async function refusal(work: Promise<void>): Promise<HttpException | null> {
  try {
    await work;
    return null;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
}

describe('BookingRateLimiter.consume', () => {
  let redis: FakeRedis;
  let limiter: BookingRateLimiter;

  beforeEach(() => {
    redis = new FakeRedis();
    limiter = new BookingRateLimiter(
      new RateLimitService(redis as unknown as Redis),
      testConfig({ BOOKING_RATE_LIMIT_MAX: '3', BOOKING_RATE_LIMIT_WINDOW_SECONDS: '60' }),
    );
  });

  it('allows exactly MAX requests per window, then 429 TOO_MANY_ATTEMPTS with retryAfterSeconds', async () => {
    for (let i = 0; i < 3; i++) expect(await refusal(limiter.consume(USER))).toBeNull();
    redis.elapse(15);

    const error = await refusal(limiter.consume(USER));

    expect(error?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error?.getResponse()).toEqual({
      code: 'TOO_MANY_ATTEMPTS',
      message: expect.any(String) as string,
      details: { retryAfterSeconds: 45 },
    });
    expect(redis.values.get(bookingRateKey(USER))).toBe(4);
  });

  it('starts counting again once the window is over', async () => {
    for (let i = 0; i < 4; i++) await refusal(limiter.consume(USER));
    redis.elapse(59);
    expect(await refusal(limiter.consume(USER))).not.toBeNull();

    redis.elapse(1);

    expect(await refusal(limiter.consume(USER))).toBeNull();
    expect(redis.values.get(bookingRateKey(USER))).toBe(1);
  });

  it('counts per user: one user at the limit does not slow another down', async () => {
    for (let i = 0; i < 4; i++) await refusal(limiter.consume(USER));

    expect(await refusal(limiter.consume(OTHER))).toBeNull();
    expect(bookingRateKey(USER)).toBe(`rl:booking:user:${USER}`);
  });
});
