import { HttpStatus, Injectable } from '@nestjs/common';
import {
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
   * The room grid and the state of every seat of the showtime, enough to draw the seat map in
   * one call. Seats without a ShowtimeSeat row (switched off when the showtime was created) are
   * not listed; their grid positions are gaps. A cancelled showtime is not shown to customers.
   */
  async seatMap(id: string): Promise<ShowtimeSeatMap> {
    const showtime = await this.prisma.showtime.findUnique({
      where: { id },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        movie: { select: { id: true, title: true, slug: true, duration: true, ageRating: true } },
        room: { select: { id: true, name: true, rows: true, cols: true } },
        showtimeSeats: {
          select: {
            status: true,
            heldUntil: true,
            price: true,
            seat: {
              select: {
                id: true,
                row: true,
                number: true,
                type: true,
                isActive: true,
                coupleGroup: true,
              },
            },
          },
          orderBy: [{ seat: { row: 'asc' } }, { seat: { number: 'asc' } }],
        },
      },
    });
    if (!showtime || showtime.status === ShowtimeStatus.CANCELLED) {
      throw apiException(
        HttpStatus.NOT_FOUND,
        ShowtimeErrorCode.SHOWTIME_NOT_FOUND,
        'Showtime not found',
      );
    }

    const now = this.clock.now();
    const { showtimeSeats, ...rest } = showtime;
    return {
      showtime: {
        ...rest,
        startsAt: rest.startsAt.toISOString(),
        endsAt: rest.endsAt.toISOString(),
      },
      seats: showtimeSeats.map(({ seat, status, heldUntil, price }) => ({
        ...seat,
        label: seatLabel(seat),
        price,
        status: publicSeatStatus({ status, heldUntil, isActive: seat.isActive }, now),
      })),
    };
  }
}
