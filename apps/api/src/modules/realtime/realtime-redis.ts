import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

const logger = new Logger('RealtimeRedis');

/**
 * Prefix of every Socket.IO channel in Redis. The gateway's adapter and the worker's emitter must
 * use the same one, or the worker's events never reach a browser. Overridden per suite in tests,
 * because Redis pub/sub ignores the logical database (`/1`, `/2`…) the suites are split into.
 */
export const REALTIME_CHANNEL_KEY = Symbol('REALTIME_CHANNEL_KEY');
export const DEFAULT_REALTIME_CHANNEL_KEY = 'ticketify:socket.io';

/**
 * - `pub`: the API adapter's publisher; `emitter`: the worker's. Fail fast while Redis is down
 *   (no offline queue): an event replayed minutes later would be stale, and clients reload the
 *   seat map when they reconnect anyway.
 * - `sub`: the API adapter's subscriber. Keeps its offline queue and retries forever, so the
 *   subscriptions survive a Redis restart (ioredis subscribes again on reconnect).
 */
export type RealtimeConnectionRole = 'pub' | 'sub' | 'emitter';

/**
 * A dedicated ioredis connection for Socket.IO, never the shared `REDIS` client: a subscriber
 * connection cannot run other commands, and the publishers need their own failure handling.
 */
export function createRealtimeConnection(url: string, role: RealtimeConnectionRole): Redis {
  const subscriber = role === 'sub';
  const connection = new Redis(url, {
    enableOfflineQueue: subscriber,
    maxRetriesPerRequest: subscriber ? null : 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    connectionName: `ticketify-realtime-${role}`,
  });
  connection.on('error', (error: Error) => logger.warn(`Redis (${role}): ${error.message}`));
  if (!subscriber) publishBestEffort(connection);
  return connection;
}

/**
 * `@socket.io/redis-adapter` and `@socket.io/redis-emitter` call `publish()` and drop the promise.
 * While Redis is down that promise rejects, and an unhandled rejection ends the Node process.
 * Wrapped here so a failed publish is a `warn` line instead: realtime is best-effort, the seat
 * map (`GET /showtimes/:id/seats`) stays the source of truth.
 */
function publishBestEffort(connection: Redis): void {
  const publish = connection.publish.bind(connection);
  const safePublish = (channel: string | Buffer, message: string | Buffer): Promise<number> =>
    publish(channel, message).catch((error: unknown) => {
      logger.warn(
        `Realtime event not delivered to other instances (best-effort): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    });
  Object.defineProperty(connection, 'publish', { value: safePublish, writable: true });
}
