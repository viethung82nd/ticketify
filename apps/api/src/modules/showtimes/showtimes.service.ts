import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AdminShowtime,
  CatalogErrorCode,
  type CreatedShowtime,
  type DayType,
  type LockedSeat,
  MovieStatus,
  RoomErrorCode,
  seatLabel,
  type SeatType,
  type ShowtimeConflict,
  ShowtimeErrorCode,
  type ShowtimePreview,
  ShowtimeStatus,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { AppConfig } from '../../config/app-config.service';
import { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { isConstraintViolation, SQLSTATE } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import type { CreateShowtimeDto } from './dto/showtime.dto';
import { assertStartsInFuture, cancelDecision, showtimeEndsAt } from './showtime-rules';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** Exclusion constraint of the raw-SQL migration (prisma/README.md). */
const NO_OVERLAP = { sqlState: SQLSTATE.exclusionViolation, constraint: 'showtimes_no_overlap' };

const byName = new Intl.Collator('vi', { sensitivity: 'base', numeric: true });

const movieNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, CatalogErrorCode.MOVIE_NOT_FOUND, 'Movie not found');
const roomNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, RoomErrorCode.ROOM_NOT_FOUND, 'Room not found');
const showtimeNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, ShowtimeErrorCode.SHOWTIME_NOT_FOUND, 'Showtime not found');
const movieEnded = () =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    ShowtimeErrorCode.MOVIE_ENDED,
    'The movie has ENDED and cannot get new showtimes',
    { field: 'movieId' },
  );
const overlap = (conflicts: ShowtimeConflict[]) =>
  apiException(
    HttpStatus.CONFLICT,
    ShowtimeErrorCode.SHOWTIME_OVERLAP,
    'Another showtime uses the room at that time',
    { field: 'startsAt', conflicts },
  );

interface MovieRow {
  id: string;
  duration: number;
  status: MovieStatus;
}

/** Row of the admin list query. */
interface AdminShowtimeRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  status: ShowtimeStatus;
  created_at: Date;
  movie_id: string;
  movie_title: string;
  movie_slug: string;
  movie_duration: number;
  room_id: string;
  room_name: string;
  seat_count: number;
  sold_count: number;
  held_count: number;
}

const toAdminShowtime = (row: AdminShowtimeRow): AdminShowtime => ({
  id: row.id,
  movie: {
    id: row.movie_id,
    title: row.movie_title,
    slug: row.movie_slug,
    duration: row.movie_duration,
  },
  room: { id: row.room_id, name: row.room_name },
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  status: row.status,
  seatCount: row.seat_count,
  soldCount: row.sold_count,
  heldCount: row.held_count,
  createdAt: row.created_at.toISOString(),
});

/**
 * Showtimes for admins (ROADMAP 1.13–1.14): create with the seat prices locked in, preview,
 * list by cinema day, cancel.
 *
 * Lock order used here, so it never forms a cycle with other flows:
 * - create: `rooms` FOR SHARE → `movies` FOR SHARE → insert `showtimes` / `showtime_seats`.
 * - cancel: `showtimes` FOR NO KEY UPDATE → its `showtime_seats` FOR UPDATE ORDER BY seat_id.
 * Seat edits (`RoomsService.updateSeats`) take `rooms` FOR UPDATE; holds (phase 2) take
 * `showtime_seats` FOR UPDATE NOWAIT ORDER BY seat_id, and their booking insert only needs a
 * key-share lock on the showtime, which FOR NO KEY UPDATE does not block.
 */
@Injectable()
export class ShowtimesService {
  private readonly cleanupMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly pricing: PricingService,
    config: AppConfig,
  ) {
    this.cleanupMinutes = config.get('SHOWTIME_CLEANUP_MINUTES');
  }

  // ─── Reads ───

  /** Every showtime (any status) starting on `date` in the cinema time zone (default: today). */
  async listByDate(date?: string): Promise<AdminShowtime[]> {
    const day = date ?? this.pricing.cinemaDay(this.clock.now()).date;
    const { from, to } = this.pricing.cinemaDayRange(day);
    const rows = await this.adminRows(
      Prisma.sql`s.starts_at >= ${from}::timestamptz AND s.starts_at < ${to}::timestamptz`,
    );
    return rows.sort(
      (a, b) => a.startsAt.localeCompare(b.startsAt) || byName.compare(a.room.name, b.room.name),
    );
  }

  async getAdmin(id: string): Promise<AdminShowtime> {
    const [row] = await this.adminRows(Prisma.sql`s.id = ${id}::uuid`);
    if (!row) throw showtimeNotFound();
    return row;
  }

  /**
   * What `create` would do, without writing: the computed `endsAt`, the day type the prices would
   * come from, and the showtimes it overlaps right now. Same validation and errors as `create`.
   * Advisory only: the exclusion constraint decides when the showtime is actually created.
   */
  async preview(dto: CreateShowtimeDto): Promise<ShowtimePreview> {
    const startsAt = new Date(dto.startsAt);
    assertStartsInFuture(startsAt, this.clock.now());
    const room = await this.prisma.room.findUnique({
      where: { id: dto.roomId },
      select: { id: true },
    });
    if (!room) throw roomNotFound();
    const movie = await this.prisma.movie.findUnique({
      where: { id: dto.movieId },
      select: { id: true, duration: true, status: true },
    });
    if (!movie) throw movieNotFound();
    if (movie.status === MovieStatus.ENDED) throw movieEnded();

    const endsAt = showtimeEndsAt(startsAt, movie.duration, this.cleanupMinutes);
    return {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      cleanupMinutes: this.cleanupMinutes,
      dayType: await this.pricing.dayType(startsAt),
      conflicts: await this.conflictsOf(this.prisma, dto.roomId, startsAt, endsAt),
    };
  }

  // ─── Writes ───

  /**
   * Creates the showtime and one ShowtimeSeat per active seat of the room, all in one
   * transaction, each seat priced `SeatPrice[seat type × dayType(startsAt)]` at this moment.
   * The prices are a snapshot: later SeatPrice or Holiday edits never change them.
   */
  async create(dto: CreateShowtimeDto): Promise<CreatedShowtime> {
    const startsAt = new Date(dto.startsAt);
    assertStartsInFuture(startsAt, this.clock.now());

    // Known once the movie is read; the overlap handler below needs it after the rollback.
    let endsAt: Date | undefined;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // FOR SHARE on the room row: a seat edit holds FOR UPDATE on the same row
        // (RoomsService.updateSeats), so the two never run at the same time. Either the edit
        // commits first and the seats read below are its result, or this transaction commits
        // first and the edit then sees the new showtime and refuses (409 ROOM_IN_USE). Without
        // the lock an edit could commit between reading the seats and committing, leaving a
        // showtime whose ShowtimeSeat rows disagree with the room. Concurrent creates all take
        // FOR SHARE, so they do not wait for each other here.
        await this.lockRoomForShare(tx, dto.roomId);
        // FOR SHARE on the movie: it cannot be ENDED or change duration until we commit.
        const movie = await this.lockMovieForShare(tx, dto.movieId);
        if (movie.status === MovieStatus.ENDED) throw movieEnded();
        endsAt = showtimeEndsAt(startsAt, movie.duration, this.cleanupMinutes);

        const seats = await tx.seat.findMany({
          where: { roomId: dto.roomId, isActive: true },
          select: { id: true, row: true, number: true, type: true },
          orderBy: [{ row: 'asc' }, { number: 'asc' }],
        });

        // The exclusion constraint `showtimes_no_overlap` rejects this insert when another
        // non-cancelled showtime in the room overlaps [startsAt, endsAt). A concurrent
        // overlapping insert makes this one wait for it, then fail once it commits.
        const showtime = await tx.showtime.create({
          data: {
            movieId: movie.id,
            roomId: dto.roomId,
            startsAt,
            endsAt,
            status: ShowtimeStatus.SCHEDULED,
          },
          select: { id: true },
        });

        const dayType = await this.pricing.dayType(startsAt, tx);
        const priceOf = await this.pricesFor(
          tx,
          seats.map((seat) => seat.type),
          dayType,
        );
        const locked: LockedSeat[] = seats.map((seat) => ({
          seatId: seat.id,
          row: seat.row,
          number: seat.number,
          label: seatLabel(seat),
          type: seat.type,
          price: priceOf(seat.type),
        }));
        await tx.showtimeSeat.createMany({
          data: locked.map((seat) => ({
            showtimeId: showtime.id,
            seatId: seat.seatId,
            price: seat.price,
          })),
        });
        return { id: showtime.id, dayType, seats: locked };
      });
      return {
        ...(await this.getAdmin(created.id)),
        dayType: created.dayType,
        seats: created.seats,
      };
    } catch (error) {
      // Matched by SQLSTATE + constraint name (see constraintViolationOf), not by message text.
      if (endsAt && isConstraintViolation(error, NO_OVERLAP)) {
        throw overlap(await this.conflictsOf(this.prisma, dto.roomId, startsAt, endsAt));
      }
      throw error;
    }
  }

  /**
   * Cancels a showtime that has not started and has no HELD/SOLD seat. Cancelling an already
   * cancelled showtime is a no-op that still answers 200 (idempotent).
   *
   * Its AVAILABLE seats are left as they are; a cancelled showtime no longer blocks its time
   * slot (the exclusion constraint ignores CANCELLED) and no longer locks the room layout.
   */
  async cancel(id: string): Promise<AdminShowtime> {
    await this.prisma.$transaction(async (tx) => {
      // NO KEY UPDATE, not UPDATE: a booking insert (phase 2) only takes a key-share lock on its
      // showtime, so it does not wait on this lock while holding seat locks (no deadlock).
      const [showtime] = await tx.$queryRaw<{ status: ShowtimeStatus; starts_at: Date }[]>`
        SELECT status, starts_at FROM showtimes WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
      if (!showtime) throw showtimeNotFound();

      // Lock every seat of the showtime in the hold flow's order (seat_id), so a hold either
      // committed before (and its HELD seats are counted here) or waits / fails NOWAIT until
      // the showtime is CANCELLED, which the hold must re-check after locking its seats.
      const seats = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM showtime_seats
        WHERE showtime_id = ${id}::uuid ORDER BY seat_id FOR UPDATE`;
      const held = seats.filter((seat) => seat.status === 'HELD').length;
      const sold = seats.filter((seat) => seat.status === 'SOLD').length;

      const decision = cancelDecision(
        { status: showtime.status, startsAt: showtime.starts_at },
        { held, sold },
        this.clock.now(),
      );
      if (decision.action === 'none') return; // second cancel: 200, nothing changes
      if (decision.action === 'reject') {
        throw decision.code === ShowtimeErrorCode.SHOWTIME_STARTED
          ? apiException(
              HttpStatus.CONFLICT,
              decision.code,
              'The showtime has already started and cannot be cancelled',
            )
          : apiException(
              HttpStatus.CONFLICT,
              decision.code,
              'Seats are held or sold; without refunds the showtime cannot be cancelled',
              { heldCount: held, soldCount: sold },
            );
      }
      await tx.showtime.update({ where: { id }, data: { status: ShowtimeStatus.CANCELLED } });
    });
    return this.getAdmin(id);
  }

  // ─── Helpers ───

  private async adminRows(where: Prisma.Sql): Promise<AdminShowtime[]> {
    const rows = await this.prisma.$queryRaw<AdminShowtimeRow[]>`
      SELECT s.id, s.starts_at, s.ends_at, s.status::text AS status, s.created_at,
             m.id AS movie_id, m.title AS movie_title, m.slug AS movie_slug,
             m.duration AS movie_duration, r.id AS room_id, r.name AS room_name,
             count(ss.seat_id)::int AS seat_count,
             (count(ss.seat_id) FILTER (WHERE ss.status = 'SOLD'))::int AS sold_count,
             (count(ss.seat_id) FILTER (WHERE ss.status = 'HELD'))::int AS held_count
      FROM showtimes s
      JOIN movies m ON m.id = s.movie_id
      JOIN rooms r ON r.id = s.room_id
      LEFT JOIN showtime_seats ss ON ss.showtime_id = s.id
      WHERE ${where}
      GROUP BY s.id, m.id, r.id`;
    return rows.map(toAdminShowtime);
  }

  private async lockRoomForShare(tx: Tx, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM rooms WHERE id = ${id}::uuid FOR SHARE`;
    if (rows.length === 0) throw roomNotFound();
  }

  private async lockMovieForShare(tx: Tx, id: string): Promise<MovieRow> {
    const [movie] = await tx.$queryRaw<MovieRow[]>`
      SELECT id, duration, status::text AS status FROM movies WHERE id = ${id}::uuid FOR SHARE`;
    if (!movie) throw movieNotFound();
    return movie;
  }

  /** One price lookup per seat type present (at most three), not one per seat. */
  private async pricesFor(
    tx: Tx,
    types: SeatType[],
    dayType: DayType,
  ): Promise<(type: SeatType) => number> {
    const prices = new Map<SeatType, number>();
    for (const type of new Set(types)) {
      prices.set(type, await this.pricing.priceFor(type, dayType, tx));
    }
    return (type) => {
      const price = prices.get(type);
      if (price === undefined) throw new Error(`No price loaded for ${type}`);
      return price;
    };
  }

  /** Non-cancelled showtimes in the room overlapping `[startsAt, endsAt)` — same rule as the constraint. */
  private async conflictsOf(
    db: Db,
    roomId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<ShowtimeConflict[]> {
    const rows = await db.$queryRaw<
      { id: string; movie_title: string; starts_at: Date; ends_at: Date }[]
    >`
      SELECT s.id, m.title AS movie_title, s.starts_at, s.ends_at
      FROM showtimes s JOIN movies m ON m.id = s.movie_id
      WHERE s.room_id = ${roomId}::uuid
        AND s.status <> 'CANCELLED'
        AND tstzrange(s.starts_at, s.ends_at, '[)')
            && tstzrange(${startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')
      ORDER BY s.starts_at`;
    return rows.map((row) => ({
      id: row.id,
      movieTitle: row.movie_title,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
    }));
  }
}
