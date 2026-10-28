import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { createRealtimeConnection } from './realtime-redis';

describe('createRealtimeConnection (publishers)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a publish while Redis is unreachable resolves 0 and warns instead of rejecting', async () => {
    // Nothing listens on port 1: the connection never becomes ready, and without an offline
    // queue the command fails at once. Unwrapped, that rejection would be unhandled.
    const connection = createRealtimeConnection('redis://127.0.0.1:1', 'emitter');
    try {
      await expect(connection.publish('channel', 'message')).resolves.toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('best-effort'));
    } finally {
      connection.disconnect();
    }
  });

  it('the subscriber keeps its offline queue (subscriptions survive a Redis restart)', () => {
    const connection = createRealtimeConnection('redis://127.0.0.1:1', 'sub');
    try {
      expect(connection).toBeInstanceOf(Redis);
      expect(connection.options.enableOfflineQueue).toBe(true);
      expect(connection.options.maxRetriesPerRequest).toBeNull();
    } finally {
      connection.disconnect();
    }
  });
});
