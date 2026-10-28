import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AuthModule } from '../auth/auth.module';
import { EmitterSeatEvents } from './emitter-seat-events';
import { GatewaySeatEvents } from './gateway-seat-events';
import { RealtimeGateway } from './realtime.gateway';
import { DEFAULT_REALTIME_CHANNEL_KEY, REALTIME_CHANNEL_KEY } from './realtime-redis';
import { SeatEvents } from './seat-events';

const channelKey = { provide: REALTIME_CHANNEL_KEY, useValue: DEFAULT_REALTIME_CHANNEL_KEY };

/**
 * Realtime on the API (ROADMAP 2.11): the Socket.IO gateway and `SeatEvents` sent through it.
 * `main.ts` installs `RealtimeIoAdapter` (Redis adapter, CORS) with `setupRealtime(app)`.
 */
@Module({
  imports: [AuthModule],
  providers: [
    RealtimeGateway,
    RateLimitService,
    channelKey,
    { provide: SeatEvents, useClass: GatewaySeatEvents },
  ],
  exports: [SeatEvents, REALTIME_CHANNEL_KEY],
})
export class RealtimeModule {}

/** Realtime in the worker: no server, `SeatEvents` published through the Redis emitter. */
@Module({
  providers: [channelKey, { provide: SeatEvents, useClass: EmitterSeatEvents }],
  exports: [SeatEvents],
})
export class RealtimeWorkerModule {}
