import { Module } from '@nestjs/common';
import { AdminBookingsService } from './admin-bookings.service';
import { DashboardService } from './dashboard.service';
import { AdminBookingsController, DashboardController } from './reports.controller';

/** Read-only admin views over bookings (ROADMAP 5.5): the booking list and the dashboard. */
@Module({
  controllers: [AdminBookingsController, DashboardController],
  providers: [AdminBookingsService, DashboardService],
})
export class ReportsModule {}
