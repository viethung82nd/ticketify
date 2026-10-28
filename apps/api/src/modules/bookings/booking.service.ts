import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type Booking as BookingView,
  BookingErrorCode,
  BookingStatus,
  seatLabel,
  type SeatType,
  ShowtimeErrorCode,
  ShowtimeSeatStatus,
  type ShowtimeStatus,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { AppConfig } from '../../config/app-config.service';
import type { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { SQLSTATE, sqlStateOf } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  bookingCode,
  holdDeadlines,
  type LockedSeatRow,
  missingCouplePartners,
  missingSeatIds,
  type ShowtimeRefusal,
  showtimeRefusal,
  unavailableSeatIds,
} from './booking-rules';
import { ExpirationScheduler } from './expiration-scheduler';
import { requestHash } from './request-hash';

type Tx = Prisma.TransactionClient;

export interface HoldInput {
  userId: string;
  showtimeId: string;
  seatIds: readonly string[];
  idempotencyKey: string;
}

export interface HoldResult {
  booking: BookingView;
  /** `false` when an earlier request with the same key and payload created it (HTTP 200). */
  created: boolean;
}

/**
 * Interactive-transaction limits of a hold. Row locks never make it wait (NOWAIT); only the
 * pool (`DATABASE_POOL_MAX`) and the per-user advisory lock can, so both bounds are generous
 * compared with the few milliseconds a hold takes.
 */
const HOLD_TX = { maxWait: 5_000, timeout: 10_000 } as const;

const showtimeNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, ShowtimeErrorCode.SHOWTIME_NOT_FOUND, 'Showtime not found');
const showtimeRefused = (code: ShowtimeRefusal) =>
  code === BookingErrorCode.SHOWTIME_CANCELLED
    ? apiException(HttpStatus.CONFLICT, code, 'The showtime has been cancelled')
    : apiException(HttpStatus.UNPROCESSABLE_ENTITY, code, 'The showtime has already started');
const seatLocked = () =>
  apiException(
    HttpStatus.CONFLICT,
    BookingErrorCode.SEAT_LOCKED,
    'Some of these seats are being booked right now; reload the seat map',
  );
const seatUnavailable = (seatIds: string[]) =>
  apiException(
    HttpStatus.CONFLICT,
    BookingErrorCode.SEAT_UNAVAILABLE,
    'Some of these seats are already held or sold',
    { seatIds },
  );
const seatNotFound = (seatIds: string[]) =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    BookingErrorCode.SEAT_NOT_FOUND,
    'Some seats are not sold for this showtime',
    { seatIds },
  );
const coupleIncomplete = (missingSeatIds: string[]) =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    BookingErrorCode.COUPLE_INCOMPLETE,
    'Couple seats are booked as a pair; add the partner seats',
    { missingSeatIds },
  );
const alreadyPending = (bookingId: string) =>
  apiException(
    HttpStatus.CONFLICT,
    BookingErrorCode.BOOKING_ALREADY_PENDING,
    'You already have a booking waiting for payment for this showtime',
    { bookingId },
  );

interface ShowtimeRow {
  room_id: string;
  status: ShowtimeStatus;
  starts_at: Date;
}

interface LockedRow {
  seat_id: string;
  status: ShowtimeSeatStatus;
  held_until: Date | null;
  booking_id: string | null;
  price: number;
}

interface SeatInfoRow {
  id: string;
  type: SeatType;
  couple_group: number | null;
}

/**
 * Seat holds (`POST /bookings`, PLAN §4, ROADMAP 2.1–2.2). Postgres is the only arbiter: no seat
 * state lives anywhere else (no Redis).
 *
 * Locks taken by a hold, in this order:
 * 1. `pg_advisory_xact_lock(hashtext(userId || showtimeId))`: serializes the requests of one user
 *    for one showtime (the "one PENDING booking" rule and same-key retries). It is not a seat lock;
 *    different users never wait on each other here.
 * 2. `showtime_seats` of the requested seats `FOR UPDATE NOWAIT ORDER BY seat_id`: a seat locked by
 *    another transaction fails at once (`55P03` → `409 SEAT_LOCKED`) instead of queueing while
 *    holding a pool connection.
 * 3. Implicit key-share locks of the inserts' foreign keys (`showtimes`, `users`).
 *
 * The showtime row itself is never locked and neither is `rooms`. Cancelling a showtime takes
 * `showtimes` FOR NO KEY UPDATE and then every seat FOR UPDATE ORDER BY seat_id; the booking
 * insert's key-share lock is compatible with FOR NO KEY UPDATE, so the two flows only meet on the
 * seat rows and serialize there. That is why the showtime status is read again after step 2.
 */
@Injectable()
export class BookingService {
  private readonly holdTtlSeconds: number;
  private readonly paymentGraceSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly scheduler: ExpirationScheduler,
    config: AppConfig,
  ) {
    this.holdTtlSeconds = config.get('HOLD_TTL_SECONDS');
    this.paymentGraceSeconds = config.get('PAYMENT_GRACE_SECONDS');
  }

  async hold(input: HoldInput): Promise<HoldResult> {
    const seatIds = [...input.seatIds].sort();
    const hash = requestHash({ showtimeId: input.showtimeId, seatIds, comboItems: [] });

    const held = await this.prisma.$transaction(
      (tx) => this.holdInTransaction(tx, input, seatIds, hash),
      HOLD_TX,
    );
    // After commit: a job must never see a booking that was rolled back.
    await this.scheduler.schedule(held.id, held.holdUntil);
    return { booking: await this.view(held.id), created: true };
  }

  /** Steps of PLAN §4 inside one interactive transaction (READ COMMITTED). */
  private async holdInTransaction(
    tx: Tx,
    input: HoldInput,
    seatIds: string[],
    hash: string,
  ): Promise<{ id: string; holdUntil: Date }> {
    const now = this.clock.now();
    const { userId, showtimeId } = input;

    // Lock per (user, showtime) pair — NOT a seat lock. Two requests of the same user for the same
    // showtime run one after the other, so the PENDING check below cannot let both through.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text || ${showtimeId}::text))`;

    // 1. The showtime exists and can be booked (read without a lock; checked again after step 2).
    const [showtime] = await tx.$queryRaw<ShowtimeRow[]>`
      SELECT room_id, status::text AS status, starts_at FROM showtimes WHERE id = ${showtimeId}::uuid`;
    if (!showtime) throw showtimeNotFound();
    const early = showtimeRefusal({ status: showtime.status, startsAt: showtime.starts_at }, now);
    if (early) throw showtimeRefused(early);

    // One live PENDING booking per user per showtime. A PENDING booking past its holdUntil does not
    // count: it is expired, only waiting for the expiry job (week 8) to mark it.
    const [pending] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM bookings
      WHERE user_id = ${userId}::uuid AND showtime_id = ${showtimeId}::uuid
        AND status = 'PENDING' AND hold_until > ${now}
      LIMIT 1`;
    if (pending) throw alreadyPending(pending.id);

    // 2. Lock the requested seats in seat_id order, failing fast if anyone else holds a lock.
    const locked = await this.lockSeats(tx, showtimeId, seatIds);

    // 3. Re-read the showtime now that its seats are ours: a cancel that committed before we got
    //    the locks is visible here (READ COMMITTED takes a new snapshot per statement).
    const [current] = await tx.$queryRaw<Pick<ShowtimeRow, 'status' | 'starts_at'>[]>`
      SELECT status::text AS status, starts_at FROM showtimes WHERE id = ${showtimeId}::uuid`;
    if (!current) throw showtimeNotFound();
    const refusal = showtimeRefusal({ status: current.status, startsAt: current.starts_at }, now);
    if (refusal) throw showtimeRefused(refusal);

    // 4. Seat checks: sold for this showtime, couple pairs complete, free (or expired hold).
    const missing = missingSeatIds(
      seatIds,
      locked.map((row) => row.seat_id),
    );
    if (missing.length > 0) throw seatNotFound(missing);
    const partners = missingCouplePartners(
      seatIds,
      await this.coupleSeats(tx, showtime.room_id, seatIds),
    );
    if (partners.length > 0) throw coupleIncomplete(partners);
    const taken = unavailableSeatIds(locked.map(toLockedSeat), now);
    if (taken.length > 0) throw seatUnavailable(taken);

    // 5. Prices are the ones locked into the showtime when it was created, not today's SeatPrice.
    const subtotal = locked.reduce((sum, row) => sum + row.price, 0);
    const discount = 0;
    const { expiresAt, holdUntil } = holdDeadlines(
      now,
      this.holdTtlSeconds,
      this.paymentGraceSeconds,
    );

    // 7–8. Booking and its seat lines.
    const booking = await tx.booking.create({
      data: {
        code: bookingCode(),
        userId,
        showtimeId,
        status: BookingStatus.PENDING,
        subtotal,
        discount,
        total: subtotal - discount,
        expiresAt,
        holdUntil,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.bookingSeat.createMany({
      data: locked.map((row) => ({
        bookingId: booking.id,
        showtimeId,
        seatId: row.seat_id,
        price: row.price,
      })),
    });

    // 9. Conditional update: a second line of defence behind the locks. Anything but one row per
    //    requested seat rolls the whole hold back.
    const updated = await tx.$executeRaw`
      UPDATE showtime_seats
      SET status = 'HELD', booking_id = ${booking.id}::uuid, held_until = ${holdUntil}
      WHERE showtime_id = ${showtimeId}::uuid AND seat_id = ANY(${seatIds}::uuid[])
        AND (status = 'AVAILABLE' OR (status = 'HELD' AND held_until <= ${now}))`;
    if (updated !== seatIds.length) throw seatUnavailable(seatIds);

    return { id: booking.id, holdUntil };
  }

  private async lockSeats(tx: Tx, showtimeId: string, seatIds: string[]): Promise<LockedRow[]> {
    try {
      return await tx.$queryRaw<LockedRow[]>`
        SELECT seat_id, status::text AS status, held_until, booking_id, price
        FROM showtime_seats
        WHERE showtime_id = ${showtimeId}::uuid AND seat_id = ANY(${seatIds}::uuid[])
        ORDER BY seat_id
        FOR UPDATE NOWAIT`;
    } catch (error) {
      if (sqlStateOf(error) === SQLSTATE.lockNotAvailable) throw seatLocked();
      throw error;
    }
  }

  /** Couple seats of the room in the pairs the request touches (the room layout is frozen). */
  private async coupleSeats(tx: Tx, roomId: string, seatIds: string[]) {
    const rows = await tx.$queryRaw<SeatInfoRow[]>`
      SELECT id, type::text AS type, couple_group FROM seats
      WHERE room_id = ${roomId}::uuid AND type = 'COUPLE' AND couple_group IN (
        SELECT couple_group FROM seats
        WHERE room_id = ${roomId}::uuid AND id = ANY(${seatIds}::uuid[])
          AND type = 'COUPLE' AND couple_group IS NOT NULL)`;
    return rows.flatMap((row) =>
      row.couple_group === null ? [] : [{ id: row.id, coupleGroup: row.couple_group }],
    );
  }

  /** The booking as the API returns it, seats by row then number. */
  async view(id: string): Promise<BookingView> {
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id },
      include: {
        seats: {
          include: {
            showtimeSeat: { select: { seat: { select: { row: true, number: true, type: true } } } },
          },
        },
      },
    });
    const seats = booking.seats
      .map((line) => {
        const { row, number, type } = line.showtimeSeat.seat;
        return {
          seatId: line.seatId,
          row,
          number,
          label: seatLabel({ row, number }),
          type,
          price: line.price,
        };
      })
      .sort((a, b) => a.row.localeCompare(b.row) || a.number - b.number);
    return {
      id: booking.id,
      code: booking.code,
      showtimeId: booking.showtimeId,
      status: booking.status,
      expiresAt: booking.expiresAt.toISOString(),
      holdUntil: booking.holdUntil.toISOString(),
      seats,
      subtotal: booking.subtotal,
      discount: booking.discount,
      total: booking.total,
      createdAt: booking.createdAt.toISOString(),
    };
  }
}

const toLockedSeat = (row: LockedRow): LockedSeatRow => ({
  seatId: row.seat_id,
  status: row.status,
  heldUntil: row.held_until,
});
