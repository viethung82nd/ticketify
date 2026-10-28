/**
 * Wall-clock time in the cinema's time zone (CINEMA_TZ, `Asia/Ho_Chi_Minh` by default).
 *
 * Shared by the API (day ranges for `GET /showtimes?date=`) and the web app (showing times and
 * turning a date + time typed by an admin into an instant), so both read the calendar the same
 * way. Offsets come from `Intl` and its time-zone database, never from hand-added hours, so a
 * zone with daylight saving time would also work.
 */

/** The cinema's time zone when nothing else is configured (same default as the API's CINEMA_TZ). */
export const DEFAULT_CINEMA_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `en-US` with h23 gives stable numeric parts for any locale the process runs in. */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockOf(instant: Date, timeZone: string): WallClock {
  const parts = new Map(
    partsFormatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.get(type);
    if (value === undefined || Number.isNaN(value)) {
      throw new RangeError(`Cannot read ${type} of ${instant.toISOString()} in ${timeZone}`);
    }
    return value;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** Offset of `timeZone` from UTC at `instant`, in minutes (`+420` for UTC+7). */
export function utcOffsetMinutes(instant: Date, timeZone: string): number {
  const wall = wallClockOf(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / MINUTE_MS);
}

/** `YYYY-MM-DD` of `instant` on the cinema's calendar. */
export function cinemaDateOf(instant: Date, timeZone: string): string {
  const wall = wallClockOf(instant, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** `HH:mm` of `instant` on the cinema's wall clock. */
export function cinemaTimeOf(instant: Date, timeZone: string): string {
  const wall = wallClockOf(instant, timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PARTS = /^(\d{2}):(\d{2})$/;

/**
 * The instant at which the cinema's wall clock shows `date` `time` (`YYYY-MM-DD`, `HH:mm`,
 * both already validated). For a wall time that does not exist or exists twice (DST changes),
 * the offset in force just before the change is used; Vietnam has no DST.
 */
export function cinemaInstantOf(date: string, time: string, timeZone: string): Date {
  const d = DATE_PARTS.exec(date);
  const t = TIME_PARTS.exec(time);
  if (!d || !t) throw new RangeError(`Expected YYYY-MM-DD and HH:mm, got "${date}" "${time}"`);
  const asUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // Guess with the offset at the UTC reading, then correct once with the offset at the guess.
  const first = asUtc - utcOffsetMinutes(new Date(asUtc), timeZone) * MINUTE_MS;
  return new Date(asUtc - utcOffsetMinutes(new Date(first), timeZone) * MINUTE_MS);
}

/** `+07:00`, `-03:30`, `+00:00`. */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** ISO 8601 with the cinema's offset, e.g. `2026-11-02T19:30:00+07:00` (what the API expects). */
export function toCinemaIso(instant: Date, timeZone: string): string {
  const wall = wallClockOf(instant, timeZone);
  const offset = formatUtcOffset(utcOffsetMinutes(instant, timeZone));
  return (
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` +
    `T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${offset}`
  );
}

/** `YYYY-MM-DD` + `days` (may be negative), as calendar arithmetic (no time zone involved). */
export function addDays(date: string, days: number): string {
  const d = DATE_PARTS.exec(date);
  if (!d) throw new RangeError(`Expected YYYY-MM-DD, got "${date}"`);
  const next = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) + days * DAY_MS);
  return next.toISOString().slice(0, 10);
}

/**
 * The cinema day `date` as a half-open UTC range `[from, to)`: from 00:00 that day to 00:00 the
 * next day on the cinema's wall clock. For Vietnam, 2026-11-02 is
 * `[2026-11-01T17:00:00Z, 2026-11-02T17:00:00Z)`.
 */
export function cinemaDayRange(date: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: cinemaInstantOf(date, '00:00', timeZone),
    to: cinemaInstantOf(addDays(date, 1), '00:00', timeZone),
  };
}
