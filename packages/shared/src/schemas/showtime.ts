import { z } from 'zod';
import { AgeRating, DayType, SeatType, ShowtimeStatus } from '../enums.js';
import { isIsoDate } from './movie.js';

const ISO_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * ISO 8601 date-time **with** a UTC offset (`Z` or `±HH:mm`), e.g. `2026-11-02T19:30:00+07:00`.
 * A value without an offset is refused: it would be read in the server's own time zone.
 */
export function isIsoInstant(value: string): boolean {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return false;
  const [, date = '', hour, minute, second = '0', , offsetHour = '0', offsetMinute = '0'] = match;
  return (
    isIsoDate(date) &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    Number(offsetHour) <= 14 &&
    Number(offsetMinute) < 60
  );
}

// ─── Requests ───

/**
 * `POST /admin/showtimes` (and `GET /admin/showtimes/preview`). `startsAt` must also be in the
 * future; the API checks that against its clock (`400 VALIDATION_FAILED`, field `startsAt`).
 */
export const createShowtimeRequestSchema = z.object({
  movieId: z.uuid({ error: 'Vui lòng chọn phim' }),
  roomId: z.uuid({ error: 'Vui lòng chọn phòng' }),
  startsAt: z.string().refine(isIsoInstant, {
    error: 'Giờ bắt đầu phải là ISO 8601 có múi giờ, ví dụ 2026-11-02T19:30:00+07:00',
  }),
});
export type CreateShowtimeRequest = z.infer<typeof createShowtimeRequestSchema>;

// ─── Responses: admin ───

const movieRefSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  slug: z.string(),
  /** Minutes. */
  duration: z.number().int(),
});

const roomRefSchema = z.object({ id: z.uuid(), name: z.string() });

/** One row of `GET /admin/showtimes?date=`. */
export const adminShowtimeSchema = z.object({
  id: z.uuid(),
  movie: movieRefSchema,
  room: roomRefSchema,
  startsAt: z.string(),
  /** startsAt + movie duration + cleaning time. */
  endsAt: z.string(),
  status: z.enum(ShowtimeStatus),
  /** Seats of the showtime (the room's active seats when it was created). */
  seatCount: z.number().int(),
  soldCount: z.number().int(),
  /**
   * Seats in status HELD, expired or not: an expired hold can still be confirmed by a late
   * payment notification, so it blocks cancelling just like a live one.
   */
  heldCount: z.number().int(),
  createdAt: z.string(),
});
export type AdminShowtime = z.infer<typeof adminShowtimeSchema>;

/** Seat of a newly created showtime, with the price locked in for it. */
export const lockedSeatSchema = z.object({
  seatId: z.uuid(),
  row: z.string(),
  number: z.number().int(),
  /** `A5`. */
  label: z.string(),
  type: z.enum(SeatType),
  /** VND, copied from SeatPrice when the showtime was created; later price edits do not change it. */
  price: z.number().int(),
});
export type LockedSeat = z.infer<typeof lockedSeatSchema>;

/** `201` body of `POST /admin/showtimes`. */
export const createdShowtimeSchema = adminShowtimeSchema.extend({
  /** Day type the prices were taken from (by the start's date in the cinema time zone). */
  dayType: z.enum(DayType),
  seats: z.array(lockedSeatSchema),
});
export type CreatedShowtime = z.infer<typeof createdShowtimeSchema>;

/** A non-cancelled showtime in the same room whose time range overlaps the requested one. */
export const showtimeConflictSchema = z.object({
  id: z.uuid(),
  movieTitle: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});
export type ShowtimeConflict = z.infer<typeof showtimeConflictSchema>;

/** `GET /admin/showtimes/preview`: what `POST` would create, without writing anything. */
export const showtimePreviewSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  cleanupMinutes: z.number().int(),
  dayType: z.enum(DayType),
  /** Empty when the slot is free right now (the database still decides at creation time). */
  conflicts: z.array(showtimeConflictSchema),
});
export type ShowtimePreview = z.infer<typeof showtimePreviewSchema>;

// ─── Responses: public ───

/** One row of `GET /showtimes?movieId=&date=`. */
export const showtimeListItemSchema = z.object({
  id: z.uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  room: roomRefSchema,
  /** Seats that can be booked now (AVAILABLE, or HELD with an expired hold). */
  availableSeats: z.number().int(),
  totalSeats: z.number().int(),
});
export type ShowtimeListItem = z.infer<typeof showtimeListItemSchema>;

/** `GET /showtimes/dates?movieId=`: cinema-calendar days with an upcoming showtime, ascending. */
export const showtimeDatesSchema = z.object({ dates: z.array(z.string()) });
export type ShowtimeDates = z.infer<typeof showtimeDatesSchema>;

/**
 * Seat status shown to customers. Lazy expiry: a HELD seat whose hold has passed is shown
 * AVAILABLE. UNAVAILABLE = the seat is not sold for this showtime (it was switched off when the
 * showtime was created, so it has no ShowtimeSeat row); it can never be booked.
 */
export const PublicSeatStatus = {
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  SOLD: 'SOLD',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type PublicSeatStatus = (typeof PublicSeatStatus)[keyof typeof PublicSeatStatus];

export const showtimeSeatSchema = z.object({
  id: z.uuid(),
  row: z.string(),
  number: z.number().int(),
  label: z.string(),
  type: z.enum(SeatType),
  isActive: z.boolean(),
  /** The two seats of a couple pair share this number and are booked together. */
  coupleGroup: z.number().int().nullable(),
  /** VND, locked when the showtime was created; `null` for an UNAVAILABLE seat without a row. */
  price: z.number().int().nullable(),
  status: z.enum(PublicSeatStatus),
});
export type ShowtimeSeat = z.infer<typeof showtimeSeatSchema>;

/**
 * `GET /showtimes/:id/seats`: everything the seat map needs in one call. Every seat of the room
 * is listed, ordered by row then number; a seat not sold for this showtime is UNAVAILABLE with
 * `price: null`. Grid positions without a seat (`rows × cols` minus `seats`) are gaps.
 */
export const showtimeSeatMapSchema = z.object({
  showtime: z.object({
    id: z.uuid(),
    startsAt: z.string(),
    endsAt: z.string(),
    status: z.enum(ShowtimeStatus),
    movie: movieRefSchema.extend({ ageRating: z.enum(AgeRating) }),
    room: roomRefSchema.extend({ rows: z.number().int(), cols: z.number().int() }),
  }),
  seats: z.array(showtimeSeatSchema),
});
export type ShowtimeSeatMap = z.infer<typeof showtimeSeatMapSchema>;

/** Machine-readable `code` values of showtime API errors (also MOVIE_NOT_FOUND, ROOM_NOT_FOUND). */
export const ShowtimeErrorCode = {
  SHOWTIME_NOT_FOUND: 'SHOWTIME_NOT_FOUND',
  /** 409: overlaps another non-cancelled showtime in the room; `details.conflicts`. */
  SHOWTIME_OVERLAP: 'SHOWTIME_OVERLAP',
  /** 409: cancel refused, the showtime has started. */
  SHOWTIME_STARTED: 'SHOWTIME_STARTED',
  /** 409: cancel refused, seats are held or sold (there are no refunds). */
  SHOWTIME_HAS_BOOKINGS: 'SHOWTIME_HAS_BOOKINGS',
  /** 422: an ENDED movie cannot get new showtimes. */
  MOVIE_ENDED: 'MOVIE_ENDED',
} as const;
export type ShowtimeErrorCode = (typeof ShowtimeErrorCode)[keyof typeof ShowtimeErrorCode];
