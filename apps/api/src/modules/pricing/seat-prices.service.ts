import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DAY_TYPE_ORDER,
  type DayType,
  PricingErrorCode,
  SEAT_TYPE_ORDER,
  type SeatPrice as SeatPriceView,
  type SeatType,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import type { SeatPrice } from '../../generated/prisma/client';
import { isPrismaError, PrismaErrorCode } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';

const toView = (row: SeatPrice): SeatPriceView => ({
  seatType: row.seatType,
  dayType: row.dayType,
  price: row.price,
  updatedAt: row.updatedAt.toISOString(),
});

/** Table order: seat type (STANDARD, VIP, COUPLE), then day type (WEEKDAY, WEEKEND, HOLIDAY). */
const tableOrder = (a: SeatPriceView, b: SeatPriceView): number =>
  SEAT_TYPE_ORDER.indexOf(a.seatType) - SEAT_TYPE_ORDER.indexOf(b.seatType) ||
  DAY_TYPE_ORDER.indexOf(a.dayType) - DAY_TYPE_ORDER.indexOf(b.dayType);

/** The 3×3 price table (ROADMAP 1.10). Rows are created by the seed, only edited here. */
@Injectable()
export class SeatPricesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<SeatPriceView[]> {
    const rows = await this.prisma.seatPrice.findMany();
    return rows.map(toView).sort(tableOrder);
  }

  /**
   * Sets one cell. Existing showtimes are NOT affected: each ShowtimeSeat stores the price that
   * was locked in when its showtime was created (PLAN §3), and bookings copy that price.
   * Only showtimes created after this call use the new price.
   */
  async update(seatType: SeatType, dayType: DayType, price: number): Promise<SeatPriceView> {
    try {
      const row = await this.prisma.seatPrice.update({
        where: { seatType_dayType: { seatType, dayType } },
        data: { price },
      });
      return toView(row);
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.recordNotFound)) {
        throw apiException(
          HttpStatus.NOT_FOUND,
          PricingErrorCode.PRICE_NOT_FOUND,
          `No price row for ${seatType} × ${dayType}`,
          { seatType, dayType },
        );
      }
      throw error;
    }
  }
}
