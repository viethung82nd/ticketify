import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service';

/** Injection token for the shared ioredis client (rate limit, health...). */
export const REDIS = Symbol('REDIS');

const logger = new Logger('Redis');

/** How long boot waits for the first connection before continuing (degraded). */
const READY_TIMEOUT_MS = 3_000;

/**
 * Resolves once the client is ready, or after the timeout. Without this, the offline-queue-less
 * client rejects commands issued right after boot (e.g. the first /health probe).
 * If Redis is down the app still starts; /health reports it and ioredis keeps reconnecting.
 * Also used by the BullMQ producer connection (infra/queue), which fails fast the same way.
 */
export function waitUntilReady(client: Redis): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      logger.warn(`Redis not ready after ${READY_TIMEOUT_MS}ms, starting anyway`);
      resolve();
    }, READY_TIMEOUT_MS);
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    client.once('ready', onReady);
  });
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: async (config: AppConfig): Promise<Redis> => {
        const client = new Redis(config.get('REDIS_URL'), {
          // Fail commands immediately while disconnected instead of queueing them,
          // so callers (and /health) see the outage right away.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
        });
        client.on('error', (error: Error) => logger.warn(`Redis error: ${error.message}`));
        await waitUntilReady(client);
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  }
}
