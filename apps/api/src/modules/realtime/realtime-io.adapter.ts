import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { AppConfig } from '../../config/app-config.service';
import { closeConnection } from '../../infra/queue/queue-connection';
import { waitUntilReady } from '../../infra/redis/redis.module';
import { createRealtimeConnection, REALTIME_CHANNEL_KEY } from './realtime-redis';

/** `true` for a request without `Origin` (not a browser) or from one of `origins`. */
export function isAllowedOrigin(origin: string | undefined, origins: readonly string[]): boolean {
  return origin === undefined || origins.includes(origin);
}

/**
 * Socket.IO server of the API (PLAN §2, §8):
 * - **Redis adapter** on two connections of its own (publisher + subscriber, not the shared
 *   `REDIS` client): an event emitted by one API instance reaches the sockets of every instance,
 *   and the worker's emitter publishes on the same channels.
 * - **WebSocket only** (no HTTP long-polling): with several API instances behind a proxy, polling
 *   needs sticky sessions; a WebSocket stays on the instance it opened on.
 * - **Origins** from `CORS_ORIGINS`, never `*`. CORS headers cover the HTTP handshake; a browser's
 *   WebSocket upgrade is not subject to CORS, so `allowRequest` also refuses a foreign `Origin`.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private constructor(
    app: INestApplication,
    private readonly origins: readonly string[],
    private readonly channelKey: string,
    /** Exposed for tests that cut the publisher to check events stay best-effort. */
    readonly pubClient: Redis,
    private readonly subClient: Redis,
  ) {
    super(app);
  }

  /** Opens the adapter's connections and waits (up to 3 s each) for Redis, like the queue. */
  static async create(app: INestApplication): Promise<RealtimeIoAdapter> {
    const config = app.get(AppConfig);
    const url = config.get('REDIS_URL');
    const pub = createRealtimeConnection(url, 'pub');
    const sub = createRealtimeConnection(url, 'sub');
    await Promise.all([waitUntilReady(pub), waitUntilReady(sub)]);
    return new RealtimeIoAdapter(
      app,
      config.get('CORS_ORIGINS'),
      app.get<string>(REALTIME_CHANNEL_KEY),
      pub,
      sub,
    );
  }

  override createIOServer(port: number, options?: Partial<ServerOptions>): Server {
    const realtimeOptions: Partial<ServerOptions> = {
      ...options,
      transports: ['websocket'],
      cors: { origin: [...this.origins] },
      allowRequest: (request, callback) =>
        callback(null, isAllowedOrigin(request.headers.origin, this.origins)),
    };
    // Socket.IO fills in every option left out; Nest's signature asks for all of them.
    const server: Server = super.createIOServer(port, realtimeOptions as ServerOptions);
    server.adapter(createAdapter(this.pubClient, this.subClient, { key: this.channelKey }));
    return server;
  }

  /** After Nest closed the Socket.IO server (and with it the adapter's subscriptions). */
  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all([closeConnection(this.pubClient), closeConnection(this.subClient)]);
  }
}

/** Installs `RealtimeIoAdapter`. Call before `app.listen()` / `app.init()` (main.ts, tests). */
export async function setupRealtime(app: INestApplication): Promise<RealtimeIoAdapter> {
  const adapter = await RealtimeIoAdapter.create(app);
  app.useWebSocketAdapter(adapter);
  return adapter;
}
