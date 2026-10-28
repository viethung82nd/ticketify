import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimitService } from './rate-limit.service';

type Reply = [Error | null, unknown];

/**
 * In-memory stand-in for the ioredis calls RateLimitService makes:
 * `multi().incr().expire(…, 'NX').ttl().exec()` and `del()`. TTLs do not tick; tests set them.
 */
class FakeRedis {
  readonly values = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  /** 'error' → commands reject; 'hang' → commands never settle. */
  mode: 'ok' | 'error' | 'hang' = 'ok';

  multi() {
    const ops: (() => unknown)[] = [];
    const chain = {
      incr: (key: string) => {
        ops.push(() => {
          const next = (this.values.get(key) ?? 0) + 1;
          this.values.set(key, next);
          return next;
        });
        return chain;
      },
      expire: (key: string, seconds: number, mode: 'NX') => {
        ops.push(() => {
          if (mode === 'NX' && this.ttls.has(key)) return 0;
          this.ttls.set(key, seconds);
          return 1;
        });
        return chain;
      },
      ttl: (key: string) => {
        ops.push(() => this.ttls.get(key) ?? -1);
        return chain;
      },
      exec: (): Promise<Reply[]> => this.settle(() => ops.map((op): Reply => [null, op()])),
    };
    return chain;
  }

  del(key: string): Promise<number> {
    return this.settle(() => {
      this.ttls.delete(key);
      return this.values.delete(key) ? 1 : 0;
    });
  }

  private settle<T>(run: () => T): Promise<T> {
    if (this.mode === 'error') return Promise.reject(new Error('Connection is closed.'));
    if (this.mode === 'hang') return new Promise<T>(() => undefined);
    return Promise.resolve(run());
  }
}

describe('RateLimitService', () => {
  let redis: FakeRedis;
  let service: RateLimitService;
  let warn: jest.SpyInstance<void, [message: unknown]>;

  beforeEach(() => {
    redis = new FakeRedis();
    service = new RateLimitService(redis as unknown as Redis);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined) as jest.SpyInstance<void, [message: unknown]>;
  });

  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
  });

  it('allows hits up to the limit, then blocks with the remaining window', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await service.hit('k', 3, 900));

    expect(results.map((r) => [r.allowed, r.count])).toEqual([
      [true, 1],
      [true, 2],
      [true, 3],
      [false, 4],
    ]);
    expect(results[3]?.retryAfterSeconds).toBe(900);
    expect(results[0]?.retryAfterSeconds).toBe(0);
  });

  it('starts the window on the first hit only (EXPIRE NX does not extend it)', async () => {
    await service.hit('k', 3, 900);
    redis.ttls.set('k', 120); // time passes
    await service.hit('k', 3, 900);

    expect(redis.ttls.get('k')).toBe(120);
  });

  it('keeps separate counters per key', async () => {
    await service.hit('a', 1, 60);
    const other = await service.hit('b', 1, 60);

    expect(other).toMatchObject({ allowed: true, count: 1 });
  });

  it('reset() clears the counter', async () => {
    await service.hit('k', 1, 60);
    await service.hit('k', 1, 60);
    await service.reset('k');

    await expect(service.hit('k', 1, 60)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('fails open and logs a warning when Redis errors', async () => {
    redis.mode = 'error';

    await expect(service.hit('k', 0, 60)).resolves.toEqual({
      allowed: true,
      count: 0,
      retryAfterSeconds: 0,
    });
    await expect(service.reset('k')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/fail-open.*Connection is closed/);
  });

  it('fails open when Redis does not answer within the timeout', async () => {
    jest.useFakeTimers();
    redis.mode = 'hang';

    const pending = service.hit('k', 0, 60);
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({ allowed: true });
    expect(warn.mock.calls[0]?.[0]).toMatch(/timed out/);
  });

  it('fails open when the MULTI reply contains a command error', async () => {
    const failing = {
      multi: () => ({
        incr: () => failing.multi(),
        expire: () => failing.multi(),
        ttl: () => failing.multi(),
        exec: () => Promise.resolve([[new Error('WRONGTYPE'), null]]),
      }),
    };
    const svc = new RateLimitService(failing as unknown as Redis);

    await expect(svc.hit('k', 0, 60)).resolves.toMatchObject({ allowed: true });
    expect(warn.mock.calls[0]?.[0]).toMatch(/WRONGTYPE/);
  });
});
