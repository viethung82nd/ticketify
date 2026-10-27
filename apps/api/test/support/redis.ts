import { Redis } from 'ioredis';
import { requiredEnv, TEST_ENV } from './test-env';

export interface TestRedis {
  /** URL of this worker's private logical database. */
  url: string;
  client: Redis;
  /** Flushes and disconnects. Call in afterAll. */
  close(): Promise<void>;
}

/**
 * Gives each Jest worker its own Redis logical database (1–15), flushed on open and close.
 * Suites inside one worker run sequentially, so they never see each other's keys.
 */
export async function createTestRedis(): Promise<TestRedis> {
  const workerId = Number(process.env.JEST_WORKER_ID ?? '1');
  const url = new URL(requiredEnv(TEST_ENV.redisUrl));
  url.pathname = `/${(workerId % 15) + 1}`;

  const client = new Redis(url.toString(), { maxRetriesPerRequest: 1 });
  await client.flushdb();

  return {
    url: url.toString(),
    client,
    async close() {
      await client.flushdb();
      await client.quit();
    },
  };
}
