import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import type { ServerToClientEvents } from '@ticketify/shared';
import type { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service';
import { closeConnection } from '../../infra/queue/queue-connection';
import { waitUntilReady } from '../../infra/redis/redis.module';
import { type EventPayload, RealtimeTransport } from './realtime-transport';
import { createRealtimeConnection, REALTIME_CHANNEL_KEY } from './realtime-redis';

/**
 * Worker side: the worker has no Socket.IO server, so it publishes on the adapter's Redis channels
 * (`@socket.io/redis-emitter`, same channel key and room names as the gateway). Every API
 * instance's adapter receives the event and hands it to its sockets in the room.
 */
@Injectable()
export class EmitterTransport
  extends RealtimeTransport
  implements OnModuleInit, OnApplicationShutdown
{
  /** Exposed for tests that cut it to check events stay best-effort. */
  readonly connection: Redis;
  private readonly emitter: Emitter<ServerToClientEvents>;

  constructor(config: AppConfig, @Inject(REALTIME_CHANNEL_KEY) channelKey: string) {
    super();
    this.connection = createRealtimeConnection(config.get('REDIS_URL'), 'emitter');
    this.emitter = new Emitter<ServerToClientEvents>(this.connection, { key: channelKey });
  }

  async onModuleInit(): Promise<void> {
    await waitUntilReady(this.connection);
  }

  emit<E extends keyof ServerToClientEvents>(
    room: string,
    event: E,
    payload: EventPayload<E>,
  ): void {
    // The emitter spreads its arguments (`emit(event, ...args)`), and TypeScript cannot see that
    // one `EventPayload<E>` is that tuple while `E` is still generic. Callers are checked at the
    // `RealtimeTransport` boundary, which is where the event and its payload are chosen together.
    const target = this.emitter.to(room) as unknown as {
      emit: (event: E, payload: EventPayload<E>) => void;
    };
    target.emit(event, payload);
  }

  async onApplicationShutdown(): Promise<void> {
    await closeConnection(this.connection);
  }
}
