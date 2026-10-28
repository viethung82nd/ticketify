import { Module } from '@nestjs/common';
import { AdminHolidaysController, AdminSeatPricesController } from './admin-pricing.controller';
import { HolidayCalendar, PrismaHolidayCalendar } from './holiday-calendar';
import { HolidaysService } from './holidays.service';
import { PricingService } from './pricing.service';
import { SeatPricesService } from './seat-prices.service';

/** Seat prices, holidays and the day-type rule (ROADMAP 1.10–1.11). */
@Module({
  controllers: [AdminSeatPricesController, AdminHolidaysController],
  providers: [
    { provide: HolidayCalendar, useClass: PrismaHolidayCalendar },
    PricingService,
    SeatPricesService,
    HolidaysService,
  ],
  exports: [PricingService],
})
export class PricingModule {}
