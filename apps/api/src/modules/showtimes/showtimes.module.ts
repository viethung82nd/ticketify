import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { AdminShowtimesController } from './admin-showtimes.controller';
import { ScheduleService } from './schedule.service';
import { ShowtimesController } from './showtimes.controller';
import { ShowtimesService } from './showtimes.service';

/** Showtimes: creation with locked prices, cancellation, public schedule and seat map (1.13–1.15). */
@Module({
  imports: [PricingModule],
  controllers: [AdminShowtimesController, ShowtimesController],
  providers: [ShowtimesService, ScheduleService],
})
export class ShowtimesModule {}
