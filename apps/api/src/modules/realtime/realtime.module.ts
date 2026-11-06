import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AuthModule } from '../auth/auth.module';
import { EmitterTransport } from './emitter-transport';
import { GatewayTransport } from './gateway-transport';
import { NotificationEvents } from './notification-events';
import { RealtimeGateway } from './realtime.gateway';
import { DEFAULT_REALTIME_CHANNEL_KEY, REALTIME_CHANNEL_KEY } from './realtime-redis';
import { RealtimeTransport } from './realtime-transport';
import { SeatEvents } from './seat-events';

const channelKey = { provide: REALTIME_CHANNEL_KEY, useValue: DEFAULT_REALTIME_CHANNEL_KEY };

/**
 * Realtime on the API (ROADMAP 2.11, 4.2): the Socket.IO gateway, and the publishers that go
 * through it. `main.ts` installs `RealtimeIoAdapter` (Redis adapter, CORS) with
 * `setupRealtime(app)`.
 */
@Module({
  imports: [AuthModule],
  providers: [
    RealtimeGateway,
    RateLimitService,
    channelKey,
    { provide: RealtimeTransport, useClass: GatewayTransport },
    SeatEvents,
    NotificationEvents,
  ],
  exports: [SeatEvents, NotificationEvents, REALTIME_CHANNEL_KEY],
})
export class RealtimeModule {}

/** Realtime in the worker: no server, one Redis emitter shared by every publisher. */
@Module({
  providers: [
    channelKey,
    { provide: RealtimeTransport, useClass: EmitterTransport },
    SeatEvents,
    NotificationEvents,
  ],
  exports: [SeatEvents, NotificationEvents, RealtimeTransport],
})
export class RealtimeWorkerModule {}
