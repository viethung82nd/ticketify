import { DayType } from '@ticketify/shared';
import { testConfig } from '../../config/testing/test-config';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { CinemaCalendar } from './cinema-calendar';
import { PricingService } from './pricing.service';
import { FakeHolidayCalendar } from './testing/fake-holiday-calendar';

// Calendar used below (Asia/Ho_Chi_Minh = UTC+7, no DST):
//   Sat 2026-10-31 · Sun 2026-11-01 · Mon 2026-11-02 · Tue 2026-11-03 · Wed 2026-11-04

/** dayType() never touches the price table, so no database is needed. */
const noDatabase = {} as PrismaService;

function pricing(holidays: string[] = [], tz?: string): PricingService {
  const config = testConfig(tz === undefined ? {} : { CINEMA_TZ: tz });
  return new PricingService(config, new FakeHolidayCalendar(holidays), noDatabase);
}

/** A fixed instant, the way a test drives `ClockService`. */
const instant = (iso: string): Date => new FakeClock(iso).now();

describe('PricingService.dayType (CINEMA_TZ = Asia/Ho_Chi_Minh)', () => {
  it('23:30 Sunday in Vietnam is WEEKEND', async () => {
    await expect(pricing().dayType(instant('2026-11-01T16:30:00Z'))).resolves.toBe(DayType.WEEKEND);
  });

  it('16:59 UTC Sunday (23:59 Sunday in Vietnam) is WEEKEND', async () => {
    await expect(pricing().dayType(instant('2026-11-01T16:59:00Z'))).resolves.toBe(DayType.WEEKEND);
  });

  it('17:00 UTC Sunday (00:00 Monday in Vietnam) is WEEKDAY', async () => {
    await expect(pricing().dayType(instant('2026-11-01T17:00:00Z'))).resolves.toBe(DayType.WEEKDAY);
  });

  it('flips exactly at local midnight', async () => {
    const service = pricing();
    const clock = new FakeClock('2026-11-01T16:59:59.999Z');

    await expect(service.dayType(clock.now())).resolves.toBe(DayType.WEEKEND);
    clock.advance({ ms: 1 });
    await expect(service.dayType(clock.now())).resolves.toBe(DayType.WEEKDAY);
  });

  it('a show from 23:30 Sunday to 01:30 Monday is priced by its start: WEEKEND', async () => {
    const service = pricing();
    const startsAt = instant('2026-11-01T16:30:00Z'); // 23:30 Sun local
    const endsAt = instant('2026-11-01T18:30:00Z'); // 01:30 Mon local

    await expect(service.dayType(startsAt)).resolves.toBe(DayType.WEEKEND);
    // Pricing by the end would have given the cheaper weekday price.
    await expect(service.dayType(endsAt)).resolves.toBe(DayType.WEEKDAY);
  });

  it('a holiday on a Saturday is HOLIDAY (holiday beats weekend)', async () => {
    const service = pricing(['2026-10-31']);

    await expect(service.dayType(instant('2026-10-31T05:00:00Z'))).resolves.toBe(DayType.HOLIDAY);
    await expect(pricing().dayType(instant('2026-10-31T05:00:00Z'))).resolves.toBe(DayType.WEEKEND);
  });

  it('a holiday on a Tuesday is HOLIDAY', async () => {
    await expect(pricing(['2026-11-03']).dayType(instant('2026-11-03T12:00:00Z'))).resolves.toBe(
      DayType.HOLIDAY,
    );
  });

  it('matches holidays on the Vietnamese date, not the UTC date', async () => {
    const service = pricing(['2026-11-03']);

    // 00:30 Tuesday local = 17:30 Monday UTC
    await expect(service.dayType(instant('2026-11-02T17:30:00Z'))).resolves.toBe(DayType.HOLIDAY);
    // 23:59 Tuesday local = 16:59 Tuesday UTC
    await expect(service.dayType(instant('2026-11-03T16:59:00Z'))).resolves.toBe(DayType.HOLIDAY);
    // 00:00 Wednesday local = 17:00 Tuesday UTC
    await expect(service.dayType(instant('2026-11-03T17:00:00Z'))).resolves.toBe(DayType.WEEKDAY);
  });

  it('ordinary weekdays are WEEKDAY, Saturday is WEEKEND', async () => {
    const service = pricing();

    await expect(service.dayType(instant('2026-11-04T03:00:00Z'))).resolves.toBe(DayType.WEEKDAY);
    await expect(service.dayType(instant('2026-10-31T03:00:00Z'))).resolves.toBe(DayType.WEEKEND);
  });

  it('follows CINEMA_TZ: in UTC, 17:00Z Sunday is still Sunday', async () => {
    await expect(pricing([], 'UTC').dayType(instant('2026-11-01T17:00:00Z'))).resolves.toBe(
      DayType.WEEKEND,
    );
  });
});

describe('CinemaCalendar', () => {
  it('returns the local calendar date and weekday', () => {
    const calendar = new CinemaCalendar('Asia/Ho_Chi_Minh');

    expect(calendar.dayOf(instant('2026-12-31T17:00:00Z'))).toEqual({
      date: '2027-01-01',
      weekday: 5,
    });
    expect(calendar.dayOf(instant('2026-11-01T16:59:00Z'))).toEqual({
      date: '2026-11-01',
      weekday: 0,
    });
  });

  it('refuses an invalid time zone', () => {
    expect(() => new CinemaCalendar('Mars/Olympus_Mons')).toThrow(RangeError);
  });
});
