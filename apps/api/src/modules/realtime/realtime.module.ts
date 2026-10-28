import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { DEFAULT_REALTIME_CHANNEL_KEY, REALTIME_CHANNEL_KEY } from './realtime-redis';

const channelKey = { provide: REALTIME_CHANNEL_KEY, useValue: DEFAULT_REALTIME_CHANNEL_KEY };

/**
 * Realtime on the API (ROADMAP 2.11): the Socket.IO gateway.
 * `main.ts` installs `RealtimeIoAdapter` (Redis adapter, CORS) with `setupRealtime(app)`.
 */
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RateLimitService, channelKey],
  exports: [REALTIME_CHANNEL_KEY],
})
export class RealtimeModule {}
