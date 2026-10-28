type Reply = [Error | null, unknown];

/**
 * In-memory stand-in for the ioredis calls RateLimitService makes:
 * `multi().incr().expire(…, 'NX').ttl().exec()` and `del()`. TTLs only move when a test sets them
 * or calls `elapse()`.
 */
export class FakeRedis {
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

  /** Time passes: TTLs go down, keys whose TTL runs out disappear (fixed window over). */
  elapse(seconds: number): void {
    for (const [key, ttl] of this.ttls) {
      if (ttl - seconds > 0) {
        this.ttls.set(key, ttl - seconds);
      } else {
        this.ttls.delete(key);
        this.values.delete(key);
      }
    }
  }

  private settle<T>(run: () => T): Promise<T> {
    if (this.mode === 'error') return Promise.reject(new Error('Connection is closed.'));
    if (this.mode === 'hang') return new Promise<T>(() => undefined);
    return Promise.resolve(run());
  }
}
