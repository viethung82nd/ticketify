import { HttpStatus, Injectable } from '@nestjs/common';
import { type Holiday as HolidayView, PricingErrorCode } from '@ticketify/shared';
import { parseIsoDate } from '../../common/calendar-date';
import { apiException } from '../../common/errors/api-error';
import { ClockService } from '../../infra/clock/clock.service';
import { isPrismaError, PrismaErrorCode } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PricingService } from './pricing.service';

/**
 * Holiday calendar (ROADMAP 1.10). Dates are calendar days in the cinema time zone, stored in a
 * `date` column and compared as `YYYY-MM-DD` in SQL, never as instants.
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly clock: ClockService,
  ) {}

  /** Holidays of `year` (default: the current year in the cinema time zone), by date. */
  async list(year?: number): Promise<HolidayView[]> {
    const y = year ?? Number(this.pricing.cinemaDay(this.clock.now()).date.slice(0, 4));
    return this.prisma.$queryRaw<HolidayView[]>`
      SELECT id, to_char(date, 'YYYY-MM-DD') AS date
      FROM holidays
      WHERE date BETWEEN ${`${y}-01-01`}::date AND ${`${y}-12-31`}::date
      ORDER BY date`;
  }

  /** `409 HOLIDAY_EXISTS` when the date is already a holiday (unique index on `date`). */
  async create(date: string): Promise<HolidayView> {
    try {
      // Prisma writes `@db.Date` from a UTC-midnight Date: an exact mapping of the calendar day.
      const row = await this.prisma.holiday.create({
        data: { date: parseIsoDate(date) },
        select: { id: true },
      });
      return { id: row.id, date };
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) {
        throw apiException(
          HttpStatus.CONFLICT,
          PricingErrorCode.HOLIDAY_EXISTS,
          'Already a holiday',
          {
            field: 'date',
            date,
          },
        );
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.holiday.delete({ where: { id } });
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.recordNotFound)) {
        throw apiException(
          HttpStatus.NOT_FOUND,
          PricingErrorCode.HOLIDAY_NOT_FOUND,
          'Holiday not found',
        );
      }
      throw error;
    }
  }
}
