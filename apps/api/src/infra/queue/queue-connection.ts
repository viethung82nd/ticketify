import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

const logger = new Logger('QueueConnection');

/**
 * - `producer`: adds jobs from the API. Fails fast while Redis is down (no offline queue), so a
 *   seat hold never waits on Redis; the caller logs and moves on.
 * - `worker`: BullMQ worker. Keeps the offline queue so it rides out Redis restarts.
 */
export type QueueConnectionRole = 'producer' | 'worker';

/**
 * A dedicated ioredis connection for BullMQ — never the shared `REDIS` client, whose
 * `maxRetriesPerRequest: 1` BullMQ rejects (its blocking commands and Lua scripts must be
 * retried until they succeed: `maxRetriesPerRequest: null`).
 */
export function createQueueConnection(url: string, role: QueueConnectionRole): Redis {
  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: role === 'worker',
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    connectionName: `ticketify-${role}`,
  });
  connection.on('error', (error: Error) => logger.warn(`Redis (${role}): ${error.message}`));
  return connection;
}

/** Closes a connection politely, or drops it when Redis does not answer within `timeoutMs`. */
export async function closeConnection(connection: Redis, timeoutMs = 1_000): Promise<void> {
  if (connection.status === 'end') return;
  const quit = connection.quit().then(
    () => true,
    () => false,
  );
  if (!(await settlesWithin(quit, timeoutMs))) connection.disconnect();
}

/** `true` when `work` settles to `true` within `ms`; `false` on timeout or a `false` result. */
export async function settlesWithin(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
