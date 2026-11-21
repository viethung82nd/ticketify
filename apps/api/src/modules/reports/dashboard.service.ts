import { Injectable } from '@nestjs/common';
import {
  ADMIN_REPORT_LIMITS,
  addDays,
  cinemaDateOf,
  cinemaDayRange,
  daysInRange,
  type OccupancyReport,
  type RevenueDay,
  type RevenueReport,
  type ShowtimeStatus,
} from '@ticketify/shared';
import { validationFailed } from '../../common/errors/api-error';
import { AppConfig } from '../../config/app-config.service';
import { ClockService } from '../../infra/clock/clock.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

interface RevenueRow {
  day: string;
  revenue: bigint;
  bookings: number;
  tickets: number;
}

interface OccupancyRow {
  id: string;
  starts_at: Date;
  status: ShowtimeStatus;
  movie_title: string;
  room_name: string;
  total_seats: number;
  sold_seats: number;
  held_seats: number;
}

/**
 * The admin dashboard (ROADMAP 5.5): revenue per cinema day and how full each showtime of a day
 * is. Read only, two aggregate queries; every day is a day on the cinema's calendar (CINEMA_TZ).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly clock: ClockService,
  ) {}

  private get timeZone(): string {
    return this.config.get('CINEMA_TZ');
  }

  private today(): string {
    return cinemaDateOf(this.clock.now(), this.timeZone);
  }

  /**
   * Revenue = `total` (after the voucher discount) of the bookings CONFIRMED on each day, by
   * `confirmedAt`: when the money arrived. NEEDS_REVIEW bookings are left out (refunded by hand),
   * and so is a booking's second payment (`REFUND_REQUIRED`), which never touches `bookings`.
   */
  async revenue(query: { from?: string; to?: string }): Promise<RevenueReport> {
    const span = ADMIN_REPORT_LIMITS.revenueDaysDefault - 1;
    const to = query.to ?? (query.from ? addDays(query.from, span) : this.today());
    const from = query.from ?? addDays(to, -span);
    if (from > to) {
      throw validationFailed([
        { field: 'to', messages: ['to must be the same day as from or later'] },
      ]);
    }
    if (daysInRange(from, to) > ADMIN_REPORT_LIMITS.revenueDaysMax) {
      throw validationFailed([
        { field: 'to', messages: [`at most ${ADMIN_REPORT_LIMITS.revenueDaysMax} days`] },
      ]);
    }

    const timeZone = this.timeZone;
    const start = cinemaDayRange(from, timeZone).from;
    const end = cinemaDayRange(to, timeZone).to;
    const rows = await this.prisma.$queryRaw<RevenueRow[]>`
      SELECT to_char(b.confirmed_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
             sum(b.total)::bigint AS revenue,
             count(*)::int AS bookings,
             sum((SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id))::int AS tickets
      FROM bookings b
      WHERE b.status = 'CONFIRMED'
        AND b.confirmed_at >= ${start}::timestamptz
        AND b.confirmed_at < ${end}::timestamptz
      GROUP BY 1`;

    const byDay = new Map(rows.map((row) => [row.day, row]));
    const days: RevenueDay[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const row = byDay.get(day);
      days.push({
        date: day,
        revenue: row ? Number(row.revenue) : 0,
        bookings: row?.bookings ?? 0,
        tickets: row?.tickets ?? 0,
      });
    }
    const totals = days.reduce(
      (sum, day) => ({
        revenue: sum.revenue + day.revenue,
        bookings: sum.bookings + day.bookings,
        tickets: sum.tickets + day.tickets,
      }),
      { revenue: 0, bookings: 0, tickets: 0 },
    );
    return { from, to, timeZone, days, totals };
  }

  /**
   * Every showtime starting on `date` (today by default), cancelled ones too, with its sellable
   * (active) seats, the seats sold, and the seats held by a hold that has not run out yet.
   */
  async occupancy(query: { date?: string }): Promise<OccupancyReport> {
    const date = query.date ?? this.today();
    const { from, to } = cinemaDayRange(date, this.timeZone);
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<OccupancyRow[]>`
      SELECT s.id, s.starts_at, s.status::text AS status, m.title AS movie_title,
             r.name AS room_name,
             (count(ss.seat_id) FILTER (WHERE seat.is_active))::int AS total_seats,
             (count(ss.seat_id) FILTER (WHERE seat.is_active AND ss.status = 'SOLD'))::int
               AS sold_seats,
             (count(ss.seat_id) FILTER (
               WHERE seat.is_active AND ss.status = 'HELD'
                 AND ss.held_until > ${now}::timestamptz
             ))::int AS held_seats
      FROM showtimes s
      JOIN movies m ON m.id = s.movie_id
      JOIN rooms r ON r.id = s.room_id
      LEFT JOIN showtime_seats ss ON ss.showtime_id = s.id
      LEFT JOIN seats seat ON seat.id = ss.seat_id
      WHERE s.starts_at >= ${from}::timestamptz AND s.starts_at < ${to}::timestamptz
      GROUP BY s.id, m.title, r.name
      ORDER BY s.starts_at, r.name`;
    return {
      date,
      showtimes: rows.map((row) => ({
        id: row.id,
        startsAt: row.starts_at.toISOString(),
        status: row.status,
        movieTitle: row.movie_title,
        roomName: row.room_name,
        totalSeats: row.total_seats,
        soldSeats: row.sold_seats,
        heldSeats: row.held_seats,
        occupancy:
          row.total_seats === 0 ? 0 : Math.round((row.sold_seats / row.total_seats) * 1e4) / 1e4,
      })),
    };
  }
}
