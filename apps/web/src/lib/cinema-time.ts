import {
  addDays,
  cinemaDateOf,
  cinemaInstantOf,
  cinemaTimeOf,
  DEFAULT_CINEMA_TIME_ZONE,
  isIsoDate,
  toCinemaIso,
} from '@ticketify/shared';

/**
 * The cinema's time zone (the API's CINEMA_TZ default). Every date and time on screen is shown
 * on the cinema's wall clock, never on the visitor's machine clock.
 */
export const CINEMA_TZ = DEFAULT_CINEMA_TIME_ZONE;

/** Today (`YYYY-MM-DD`) on the cinema's calendar. */
export const cinemaToday = (): string => cinemaDateOf(new Date(), CINEMA_TZ);

/** Current year on the cinema's calendar. */
export const cinemaYear = (): number => Number(cinemaToday().slice(0, 4));

/** `2026-11-02T12:30:00Z` → `19:30` (cinema time). */
export const cinemaTime = (iso: string): string => cinemaTimeOf(new Date(iso), CINEMA_TZ);

/** `2026-11-02T12:30:00Z` → `2026-11-02` (cinema calendar). */
export const cinemaDate = (iso: string): string => cinemaDateOf(new Date(iso), CINEMA_TZ);

/** `n` consecutive calendar days starting at `from`. */
export const nextDays = (from: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => addDays(from, i));

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOOSE_TIME = /^(\d{1,2})\s*[:.hH]?\s*(\d{2})$/;

/**
 * A 24-hour time typed by hand → `HH:mm`, or `null` when it is not one. Accepts `19:30`,
 * `9:30`, `1930`, `19.30`, `19h30`. No AM/PM: the field is the cinema's 24-hour wall clock.
 */
export function normalizeTime(text: string): string | null {
  const match = LOOSE_TIME.exec(text.trim());
  if (!match) return null;
  const time = `${match[1]!.padStart(2, '0')}:${match[2]!}`;
  return TIME_PATTERN.test(time) ? time : null;
}

/**
 * Date + time typed in the cinema's time zone → ISO 8601 with its offset
 * (`2026-11-02T19:30:00+07:00`), or `null` while either is incomplete. Converted with `Intl`, not
 * with `<input type="datetime-local">`, which would read the time in the visitor's zone.
 */
export function cinemaIso(date: string, time: string): string | null {
  if (!isIsoDate(date) || !TIME_PATTERN.test(time)) return null;
  return toCinemaIso(cinemaInstantOf(date, time, CINEMA_TZ), CINEMA_TZ);
}

const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const WEEKDAY_LONG = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/** Day of week of a calendar date (0 = Sunday), without any time zone involved. */
const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** `2026-11-02` → `{ weekday: 'T2', day: '02/11' }`, for date chips. */
export function dayChipLabel(date: string): { weekday: string; day: string } {
  return {
    weekday: WEEKDAY_SHORT[weekdayOf(date)] ?? '',
    day: `${date.slice(8, 10)}/${date.slice(5, 7)}`,
  };
}

/** `2026-11-02` → `Thứ Hai, 02/11/2026`. */
export function longDayLabel(date: string): string {
  return `${WEEKDAY_LONG[weekdayOf(date)] ?? ''}, ${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}
