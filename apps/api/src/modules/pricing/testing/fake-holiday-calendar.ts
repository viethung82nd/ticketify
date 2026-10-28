import { HolidayCalendar } from '../holiday-calendar';

/** In-memory holidays for unit tests. */
export class FakeHolidayCalendar extends HolidayCalendar {
  readonly dates: Set<string>;

  constructor(dates: string[] = []) {
    super();
    this.dates = new Set(dates);
  }

  isHoliday(date: string): Promise<boolean> {
    return Promise.resolve(this.dates.has(date));
  }
}
