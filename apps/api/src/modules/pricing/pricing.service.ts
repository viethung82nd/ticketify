import { HttpStatus, Injectable } from '@nestjs/common';
import { type DayType, PricingErrorCode, type SeatType } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { AppConfig } from '../../config/app-config.service';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CinemaCalendar, type CinemaDay, classifyDay } from './cinema-calendar';
import { HolidayCalendar } from './holiday-calendar';

/**
 * Ticket pricing rules (PLAN §1): price = SeatPrice[seat type × day type], where the day type
 * comes from the cinema's calendar (CINEMA_TZ, default Asia/Ho_Chi_Minh).
 *
 * Showtime creation (ROADMAP 1.13) calls `dayType(startsAt)` and `priceFor()` once and locks the
 * result into every ShowtimeSeat, so later price or holiday edits never reprice a showtime.
 */
@Injectable()
export class PricingService {
  private readonly calendar: CinemaCalendar;

  constructor(
    config: AppConfig,
    private readonly holidays: HolidayCalendar,
    private readonly prisma: PrismaService,
  ) {
    this.calendar = new CinemaCalendar(config.get('CINEMA_TZ'));
  }

  /** The calendar day of `at` on the cinema's wall clock. */
  cinemaDay(at: Date): CinemaDay {
    return this.calendar.dayOf(at);
  }

  /**
   * Day type of a showtime starting at `at`: HOLIDAY if that cinema-calendar day is in the
   * Holiday table, else WEEKEND on Saturday/Sunday, else WEEKDAY.
   *
   * Pass the showtime's **start**: a show from 23:30 Sunday to 01:30 Monday is a Sunday
   * (WEEKEND) show. `at` is a parameter rather than "now" so callers and tests choose the instant.
   */
  async dayType(at: Date, tx?: Prisma.TransactionClient): Promise<DayType> {
    const day = this.calendar.dayOf(at);
    return classifyDay(day, await this.holidays.isHoliday(day.date, tx));
  }

  /** Current price (VND) of one seat of `seatType` on a `dayType` day. */
  async priceFor(
    seatType: SeatType,
    dayType: DayType,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = tx ?? this.prisma;
    const row = await db.seatPrice.findUnique({
      where: { seatType_dayType: { seatType, dayType } },
      select: { price: true },
    });
    if (!row) {
      throw apiException(
        HttpStatus.NOT_FOUND,
        PricingErrorCode.PRICE_NOT_FOUND,
        `No price for ${seatType} seats on ${dayType} days`,
        { seatType, dayType },
      );
    }
    return row.price;
  }
}
