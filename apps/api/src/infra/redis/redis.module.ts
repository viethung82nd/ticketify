import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service';

/** Injection token for the shared ioredis client (rate limit, health...). */
export const REDIS = Symbol('REDIS');

const logger = new Logger('Redis');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig): Redis => {
        const client = new Redis(config.get('REDIS_URL'), {
          // Fail commands immediately while disconnected instead of queueing them,
          // so callers (and /health) see the outage right away.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
        });
        client.on('error', (error: Error) => logger.warn(`Redis error: ${error.message}`));
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
