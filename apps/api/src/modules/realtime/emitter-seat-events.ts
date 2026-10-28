import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.service';
import { closeConnection } from '../../infra/queue/queue-connection';
import { waitUntilReady } from '../../infra/redis/redis.module';
import { createRealtimeConnection, REALTIME_CHANNEL_KEY } from './realtime-redis';
import { SeatEvents, type SeatEventName, type SeatEventPayload } from './seat-events';

/**
 * Worker side: the worker has no Socket.IO server, so it publishes on the adapter's Redis channels
 * (`@socket.io/redis-emitter`, same channel key and room names as the gateway). Every API
 * instance's adapter receives the event and hands it to its sockets in the room.
 */
@Injectable()
export class EmitterSeatEvents extends SeatEvents implements OnModuleInit, OnApplicationShutdown {
  /** Exposed for tests that cut it to check events stay best-effort. */
  readonly connection: Redis;
  private readonly emitter: Emitter;

  constructor(config: AppConfig, @Inject(REALTIME_CHANNEL_KEY) channelKey: string) {
    super();
    this.connection = createRealtimeConnection(config.get('REDIS_URL'), 'emitter');
    this.emitter = new Emitter(this.connection, { key: channelKey });
  }

  async onModuleInit(): Promise<void> {
    await waitUntilReady(this.connection);
  }

  protected emit(room: string, event: SeatEventName, payload: SeatEventPayload): void {
    this.emitter.to(room).emit(event, payload);
  }

  async onApplicationShutdown(): Promise<void> {
    await closeConnection(this.connection);
  }
}
