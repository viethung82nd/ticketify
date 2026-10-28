import {
  addDays,
  cinemaDateOf,
  cinemaDayRange,
  cinemaInstantOf,
  cinemaTimeOf,
  toCinemaIso,
  utcOffsetMinutes,
} from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';

// Shared with the web app: the admin form turns "date + time in the cinema" into an instant
// with these, and the movie page shows times with them.

const instant = (iso: string): Date => new FakeClock(iso).now();
const VN = 'Asia/Ho_Chi_Minh';

describe('cinema time helpers (@ticketify/shared)', () => {
  it('reads date, time and offset in Vietnam (UTC+7)', () => {
    const at = instant('2026-11-01T16:30:00Z'); // 23:30 Sunday in Vietnam

    expect(utcOffsetMinutes(at, VN)).toBe(420);
    expect(cinemaDateOf(at, VN)).toBe('2026-11-01');
    expect(cinemaTimeOf(at, VN)).toBe('23:30');
    expect(cinemaDateOf(instant('2026-11-01T17:00:00Z'), VN)).toBe('2026-11-02');
  });

  it('turns a wall-clock date + time into the instant and an ISO string with offset', () => {
    const at = cinemaInstantOf('2026-11-02', '19:30', VN);

    expect(at.toISOString()).toBe('2026-11-02T12:30:00.000Z');
    expect(toCinemaIso(at, VN)).toBe('2026-11-02T19:30:00+07:00');
  });

  it('round-trips midnight and the last minute of a day', () => {
    expect(cinemaInstantOf('2026-11-02', '00:00', VN).toISOString()).toBe(
      '2026-11-01T17:00:00.000Z',
    );
    expect(toCinemaIso(cinemaInstantOf('2026-11-02', '23:59', VN), VN)).toBe(
      '2026-11-02T23:59:00+07:00',
    );
  });

  it('uses the time-zone database, so DST zones get the right offset', () => {
    const ny = 'America/New_York';
    // 2026-11-01 is the US fall-back day: 00:00 is EDT (-4), 12:00 is EST (-5).
    expect(toCinemaIso(cinemaInstantOf('2026-11-01', '00:00', ny), ny)).toBe(
      '2026-11-01T00:00:00-04:00',
    );
    expect(toCinemaIso(cinemaInstantOf('2026-11-01', '12:00', ny), ny)).toBe(
      '2026-11-01T12:00:00-05:00',
    );
    const { from, to } = cinemaDayRange('2026-11-01', ny);
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(25);
  });

  it('adds calendar days across months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});
