import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AgeRating,
  type SeatType,
  type ShowtimeSeatStatus,
  seatLabel,
  type ShowtimeDates,
  ShowtimeErrorCode,
  type ShowtimeListItem,
  type ShowtimeSeatMap,
  ShowtimeStatus,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { ClockService } from '../../infra/clock/clock.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { publicSeatStatus } from './showtime-rules';

interface ListRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  room_id: string;
  room_name: string;
  available_seats: number;
  total_seats: number;
}

/** One row of the seat-map statement: the showtime head repeated, then one seat (or nulls). */
interface SeatMapRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  status: ShowtimeStatus;
  movie_id: string;
  movie_title: string;
  movie_slug: string;
  movie_duration: number;
  movie_age_rating: AgeRating;
  room_id: string;
  room_name: string;
  room_rows: number;
  room_cols: number;
  seat_id: string | null;
  seat_row: string | null;
  seat_number: number | null;
  seat_type: SeatType | null;
  seat_is_active: boolean | null;
  seat_couple_group: number | null;
  ss_status: ShowtimeSeatStatus | null;
  ss_held_until: Date | null;
  ss_price: number | null;
}

/**
 * Public schedule and seat map (ROADMAP 1.15). Read-only: lazy expiry is applied when reading
 * (`publicSeatStatus`, and the same rule in SQL for the counts), nothing is ever written here.
 * "Now" always comes from `ClockService`, never from the database's `now()`.
 */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly pricing: PricingService,
  ) {}

  /**
   * SCHEDULED showtimes of a movie that start on `date` (cinema time zone, default today) and
   * have not started yet, by start time.
   */
  async listForMovie(movieId: string, date?: string): Promise<ShowtimeListItem[]> {
    const now = this.clock.now();
    const day = date ?? this.pricing.cinemaDay(now).date;
    // `date` is a day on the cinema's calendar: [00:00, 24:00) there, converted to UTC.
    const { from, to } = this.pricing.cinemaDayRange(day);
    // Available = what publicSeatStatus() returns AVAILABLE for: an active seat that is
    // AVAILABLE, or HELD with an expired hold.
    const rows = await this.prisma.$queryRaw<ListRow[]>`
      SELECT s.id, s.starts_at, s.ends_at, r.id AS room_id, r.name AS room_name,
             (count(ss.seat_id) FILTER (
               WHERE seat.is_active
                 AND (ss.status = 'AVAILABLE'
                      OR (ss.status = 'HELD' AND ss.held_until <= ${now}::timestamptz))
             ))::int AS available_seats,
             (count(ss.seat_id) FILTER (WHERE seat.is_active))::int AS total_seats
      FROM showtimes s
      JOIN rooms r ON r.id = s.room_id
      LEFT JOIN showtime_seats ss ON ss.showtime_id = s.id
      LEFT JOIN seats seat ON seat.id = ss.seat_id
      WHERE s.movie_id = ${movieId}::uuid
        AND s.status = 'SCHEDULED'
        AND s.starts_at > ${now}::timestamptz
        AND s.starts_at >= ${from}::timestamptz
        AND s.starts_at < ${to}::timestamptz
      GROUP BY s.id, r.id
      ORDER BY s.starts_at, r.name`;
    return rows.map((row) => ({
      id: row.id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      room: { id: row.room_id, name: row.room_name },
      availableSeats: row.available_seats,
      totalSeats: row.total_seats,
    }));
  }

  /**
   * Cinema-calendar days that have at least one upcoming SCHEDULED showtime of the movie, so the
   * movie page can point to the nearest day with showtimes when the chosen one has none.
   */
  async datesForMovie(movieId: string): Promise<ShowtimeDates> {
    const showtimes = await this.prisma.showtime.findMany({
      where: { movieId, status: ShowtimeStatus.SCHEDULED, startsAt: { gt: this.clock.now() } },
      select: { startsAt: true },
      orderBy: { startsAt: 'asc' },
    });
    const dates = showtimes.map((showtime) => this.pricing.cinemaDay(showtime.startsAt).date);
    return { dates: [...new Set(dates)] };
  }

  /**
   * The room grid and every seat of the room with its state for this showtime, enough to draw
   * the seat map in one call: the room's seats left-joined with the showtime's ShowtimeSeat
   * rows. A seat without a row (switched off when the showtime was created) is UNAVAILABLE with
   * `price: null`. A cancelled showtime is not shown to customers. A showtime that has started
   * is still shown; holding seats must check `startsAt > now` itself (ROADMAP 2.2).
   */
  async seatMap(id: string): Promise<ShowtimeSeatMap> {
    // ONE statement (ROADMAP 6.3): the showtime with its movie and room, and every seat of the
    // room left-joined with this showtime's ShowtimeSeat row (PK showtime_id + seat_id, so at most
    // one). The nested Prisma select it replaces sent five statements per call, the last binding
    // one parameter per seat (192 in a load-test room), and its result mapping made this the most
    // CPU-expensive public endpoint under load (load-tests/results/README.md).
    const rows = await this.prisma.$queryRaw<SeatMapRow[]>`
      SELECT s.id, s.starts_at, s.ends_at, s.status::text AS status,
             m.id AS movie_id, m.title AS movie_title, m.slug AS movie_slug,
             m.duration AS movie_duration, m.age_rating::text AS movie_age_rating,
             r.id AS room_id, r.name AS room_name, r.rows AS room_rows, r.cols AS room_cols,
             seat.id AS seat_id, seat.row AS seat_row, seat.number AS seat_number,
             seat.type::text AS seat_type, seat.is_active AS seat_is_active,
             seat.couple_group AS seat_couple_group,
             ss.status::text AS ss_status, ss.held_until AS ss_held_until, ss.price AS ss_price
      FROM showtimes s
      JOIN movies m ON m.id = s.movie_id
      JOIN rooms r ON r.id = s.room_id
      LEFT JOIN seats seat ON seat.room_id = r.id
      LEFT JOIN showtime_seats ss ON ss.showtime_id = s.id AND ss.seat_id = seat.id
      WHERE s.id = ${id}::uuid
      ORDER BY seat.row, seat.number`;
    const head = rows[0];
    if (!head || head.status === ShowtimeStatus.CANCELLED) {
      throw apiException(
        HttpStatus.NOT_FOUND,
        ShowtimeErrorCode.SHOWTIME_NOT_FOUND,
        'Showtime not found',
      );
    }

    const now = this.clock.now();
    return {
      showtime: {
        id: head.id,
        startsAt: head.starts_at.toISOString(),
        endsAt: head.ends_at.toISOString(),
        status: head.status,
        movie: {
          id: head.movie_id,
          title: head.movie_title,
          slug: head.movie_slug,
          duration: head.movie_duration,
          ageRating: head.movie_age_rating,
        },
        room: {
          id: head.room_id,
          name: head.room_name,
          rows: head.room_rows,
          cols: head.room_cols,
        },
      },
      // A room without seats still returns its showtime row, with every seat column null.
      seats: rows.flatMap((row) => {
        if (row.seat_id === null) return [];
        const seat = { row: row.seat_row!, number: row.seat_number! };
        const showtimeSeat =
          row.ss_status === null
            ? null
            : { status: row.ss_status, heldUntil: row.ss_held_until, price: row.ss_price! };
        return [
          {
            id: row.seat_id,
            ...seat,
            type: row.seat_type!,
            isActive: row.seat_is_active!,
            coupleGroup: row.seat_couple_group,
            label: seatLabel(seat),
            price: showtimeSeat?.price ?? null,
            status: publicSeatStatus({ showtimeSeat, isActive: row.seat_is_active! }, now),
          },
        ];
      }),
    };
  }
}
