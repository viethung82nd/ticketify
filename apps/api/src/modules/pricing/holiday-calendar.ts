import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Answers "is this calendar day a holiday?". Unit tests swap in `FakeHolidayCalendar`. */
export abstract class HolidayCalendar {
  /**
   * @param date `YYYY-MM-DD` in the cinema time zone.
   * @param tx run inside the caller's transaction (e.g. when creating a showtime).
   */
  abstract isHoliday(date: string, tx?: Prisma.TransactionClient): Promise<boolean>;
}

/** Reads the `holidays` table, comparing `date` columns to a `YYYY-MM-DD` literal. */
@Injectable()
export class PrismaHolidayCalendar extends HolidayCalendar {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHoliday(date: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const db = tx ?? this.prisma;
    const rows = await db.$queryRaw<{ found: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM holidays WHERE date = ${date}::date) AS found`;
    return rows[0]?.found === true;
  }
}
