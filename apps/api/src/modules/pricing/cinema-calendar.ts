import { DayType } from '@ticketify/shared';

/** A calendar day as seen on the cinema's wall clock. */
export interface CinemaDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Converts instants to the calendar day in `timeZone` with `Intl.DateTimeFormat`, so offsets
 * and any future DST rules come from the time-zone database, never from hand-added hours.
 */
export class CinemaCalendar {
  private readonly formatter: Intl.DateTimeFormat;

  /** `timeZone` is validated at startup (CINEMA_TZ in env.schema.ts); invalid ones throw here. */
  constructor(readonly timeZone: string) {
    this.formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    });
  }

  dayOf(at: Date): CinemaDay {
    const parts = new Map(this.formatter.formatToParts(at).map((part) => [part.type, part.value]));
    const year = parts.get('year') ?? '';
    const weekday = WEEKDAY_INDEX[parts.get('weekday') ?? ''];
    if (!/^\d{4}$/.test(year) || weekday === undefined) {
      throw new RangeError(`Cannot read a calendar day for ${at.toISOString()}`);
    }
    return { date: `${year}-${parts.get('month')}-${parts.get('day')}`, weekday };
  }
}

/** Holiday beats weekend: a public holiday on a Saturday is priced as HOLIDAY. */
export function classifyDay(day: CinemaDay, isHoliday: boolean): DayType {
  if (isHoliday) return DayType.HOLIDAY;
  return day.weekday === 0 || day.weekday === 6 ? DayType.WEEKEND : DayType.WEEKDAY;
}
