import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type Booking as BookingView,
  type BookingAlreadyPendingDetails,
  BookingErrorCode,
  BookingStatus,
  CommonErrorCode,
  PaymentStatus,
  type SeatType,
  ShowtimeErrorCode,
  ShowtimeSeatStatus,
  type ShowtimeStatus,
  type VoucherDiscountType,
  type VoucherMinSubtotalDetails,
  type VoucherPeriodDetails,
  VoucherUsageStatus,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { AppConfig } from '../../config/app-config.service';
import type { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { isConstraintViolation, SQLSTATE, sqlStateOf } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SeatEvents } from '../realtime/seat-events';
import {
  type VoucherRefusal,
  voucherDiscount,
  voucherLimitRefusal,
  voucherTermsRefusal,
} from '../vouchers/voucher-rules';
import { BookingExpirationQueue } from './booking-expiration-queue';
import {
  bookingCode,
  bookingTotals,
  holdDeadlines,
  type LockedSeatRow,
  missingCouplePartners,
  missingSeatIds,
  type ShowtimeRefusal,
  showtimeRefusal,
  unavailableSeatIds,
} from './booking-rules';
import { BookingViews } from './booking-views';
import { requestHash } from './request-hash';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

export interface ComboItemInput {
  comboId: string;
  quantity: number;
}

export interface HoldInput {
  userId: string;
  showtimeId: string;
  seatIds: readonly string[];
  comboItems: readonly ComboItemInput[];
  /** Normalized (trimmed, upper case) by the DTO; `null` = no voucher. */
  voucherCode: string | null;
  idempotencyKey: string;
}

export interface HoldResult {
  booking: BookingView;
  /** `false` when an earlier request with the same key and payload created it (HTTP 200). */
  created: boolean;
}

/** What the hold transaction ended with. */
type HoldOutcome =
  | { kind: 'created'; id: string; holdUntil: Date; seatIds: string[] }
  /** The user already used this Idempotency-Key; nothing was written. */
  | { kind: 'existing'; id: string; requestHash: string };

/**
 * Interactive-transaction limits of a hold. Row locks never make it wait (NOWAIT); only the
 * pool (`DATABASE_POOL_MAX`) and the per-user advisory lock can, so both bounds are generous
 * compared with the few milliseconds a hold takes.
 */
const HOLD_TX = { maxWait: 5_000, timeout: 10_000 } as const;

/**
 * How long a hold with a voucher waits for the voucher's row lock (ROADMAP 5.2). Unlike a seat
 * (NOWAIT), the voucher row is shared by everyone using the code, so holds of a popular voucher
 * queue there, each for the few milliseconds the end of a hold takes. 2 s is far above that queue
 * and well under HOLD_TX.timeout; past it the hold rolls back with `503 DATABASE_BUSY` (nothing
 * written, retry) instead of keeping a pool connection waiting.
 */
const VOUCHER_LOCK_TIMEOUT_MS = 2_000;

/**
 * Interactive-transaction limits of a cancel. Unlike a hold it waits on row locks: on the booking
 * row while its expiry runs, and on its seats while a hold (NOWAIT, milliseconds) or a showtime
 * cancel has them. All of those are short, so the bounds are the same as HOLD_TX.
 */
const CANCEL_TX = { maxWait: 5_000, timeout: 10_000 } as const;

/** unique(user_id, idempotency_key) — the database, not this code, decides who used a key first. */
const IDEMPOTENCY_UNIQUE = {
  sqlState: SQLSTATE.uniqueViolation,
  constraint: 'bookings_user_id_idempotency_key_key',
};

const voucherRefused = (refusal: VoucherRefusal) => {
  switch (refusal.code) {
    case 'VOUCHER_NOT_AVAILABLE':
      return apiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        refusal.code,
        'This voucher does not exist or is not available',
      );
    case 'VOUCHER_NOT_IN_EFFECT': {
      const details: VoucherPeriodDetails = {
        startsAt: refusal.startsAt.toISOString(),
        endsAt: refusal.endsAt.toISOString(),
      };
      return apiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        refusal.code,
        'This voucher cannot be used at this time',
        details,
      );
    }
    case 'VOUCHER_MIN_SUBTOTAL_NOT_MET': {
      const details: VoucherMinSubtotalDetails = {
        minSubtotal: refusal.minSubtotal,
        subtotal: refusal.subtotal,
      };
      return apiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        refusal.code,
        'The booking is below the minimum amount for this voucher',
        details,
      );
    }
    case 'VOUCHER_USAGE_LIMIT_REACHED':
      return apiException(HttpStatus.CONFLICT, refusal.code, 'This voucher has been used up', {
        usageLimit: refusal.usageLimit,
      });
    case 'VOUCHER_USER_LIMIT_REACHED':
      return apiException(
        HttpStatus.CONFLICT,
        refusal.code,
        'You have already used this voucher as many times as allowed',
        { perUserLimit: refusal.perUserLimit },
      );
  }
};
const voucherBusy = () =>
  apiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    CommonErrorCode.DATABASE_BUSY,
    'Too many bookings are using this voucher right now; try again',
  );

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
const comboNotAvailable = (comboIds: string[]) =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    BookingErrorCode.COMBO_NOT_AVAILABLE,
    'Some combos do not exist or are not on sale',
    { comboIds },
  );
const alreadyPending = (existing: { id: string; expires_at: Date }) => {
  const details: BookingAlreadyPendingDetails = {
    existingBookingId: existing.id,
    expiresAt: existing.expires_at.toISOString(),
    bookingId: existing.id,
  };
  return apiException(
    HttpStatus.CONFLICT,
    BookingErrorCode.BOOKING_ALREADY_PENDING,
    'You already have a booking waiting for payment for this showtime',
    details,
  );
};
const bookingNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, BookingErrorCode.BOOKING_NOT_FOUND, 'Booking not found');
const notCancellable = () =>
  apiException(
    HttpStatus.CONFLICT,
    BookingErrorCode.BOOKING_NOT_CANCELLABLE,
    'This booking has been paid or is under review and can no longer be cancelled',
  );
const paymentInProgress = () =>
  apiException(
    HttpStatus.CONFLICT,
    BookingErrorCode.BOOKING_HAS_PAYMENT_IN_PROGRESS,
    'A payment for this booking is in progress; wait for its result before cancelling',
  );
const keyReused = () =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    BookingErrorCode.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used for a different booking request',
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

interface VoucherRow {
  id: string;
  discount_type: VoucherDiscountType;
  discount_value: number;
  max_discount: number | null;
  min_subtotal: number;
  usage_limit: number | null;
  per_user_limit: number | null;
  starts_at: Date;
  ends_at: Date;
  is_active: boolean;
}

interface SeatInfoRow {
  id: string;
  type: SeatType;
  couple_group: number | null;
}

/**
 * Seat holds (`POST /bookings`, PLAN §4, ROADMAP 2.1–2.4). Postgres is the only arbiter: no seat
 * state lives anywhere else (no Redis).
 *
 * Locks taken by a hold, in this order:
 * 1. `pg_advisory_xact_lock(hashtext(userId || showtimeId))`: serializes the requests of one user
 *    for one showtime (the "one PENDING booking" rule and same-key retries). It is not a seat lock;
 *    different users never wait on each other here.
 * 2. `showtime_seats` of the requested seats `FOR UPDATE NOWAIT ORDER BY seat_id`: a seat locked by
 *    another transaction fails at once (`55P03` → `409 SEAT_LOCKED`) instead of queueing while
 *    holding a pool connection.
 * 3. With a `voucherCode` only: the voucher row `FOR UPDATE` (ROADMAP 5.2), after the seats and
 *    every seat and combo check, right before the inserts. It is the one lock a hold waits for
 *    (bounded by VOUCHER_LOCK_TIMEOUT_MS): everyone using the code shares that row, so failing
 *    fast would refuse a popular voucher to nearly everyone. Taken last, it is held only for the
 *    inserts, and a request refused for its seats never queues for it. No cycle: a hold waiting
 *    for it holds only its own seats, and whoever has the voucher row never waits for a seat (a
 *    hold already has its seats; an admin voucher edit or delete locks nothing else). Confirm and
 *    expiry never lock `vouchers`: they update the booking's own `voucher_usages` row, which no
 *    hold touches (a hold only inserts its new row and counts).
 * 4. Implicit key-share locks of the inserts' foreign keys (`showtimes`, `users`, `combos`,
 *    `vouchers` — the last one already ours).
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
    private readonly expirations: BookingExpirationQueue,
    private readonly views: BookingViews,
    private readonly seatEvents: SeatEvents,
    config: AppConfig,
  ) {
    this.holdTtlSeconds = config.get('HOLD_TTL_SECONDS');
    this.paymentGraceSeconds = config.get('PAYMENT_GRACE_SECONDS');
  }

  /**
   * Holds the seats for a new PENDING booking, or returns the booking an earlier request with the
   * same `Idempotency-Key` created (`created: false`) when the payload is the same. The same key
   * with another payload is `422 IDEMPOTENCY_KEY_REUSED`.
   */
  async hold(input: HoldInput): Promise<HoldResult> {
    const seatIds = [...input.seatIds].sort();
    const hash = requestHash({
      showtimeId: input.showtimeId,
      seatIds,
      comboItems: input.comboItems,
      voucherCode: input.voucherCode,
    });

    let outcome: HoldOutcome;
    try {
      outcome = await this.prisma.$transaction(
        (tx) => this.holdInTransaction(tx, input, seatIds, hash),
        HOLD_TX,
      );
    } catch (error) {
      // Lost a race on the key with a request the advisory lock did not serialize (same key, other
      // showtime). The winner has committed by now: answer from its booking, never with a 5xx.
      if (!isConstraintViolation(error, IDEMPOTENCY_UNIQUE)) throw error;
      const existing = await this.findByKey(this.prisma, input.userId, input.idempotencyKey);
      if (!existing) throw error;
      outcome = { kind: 'existing', ...existing };
    }

    if (outcome.kind === 'existing') {
      if (outcome.requestHash !== hash) throw keyReused();
      return { booking: await this.views.byId(outcome.id), created: false };
    }
    // After commit: a job must never see a booking that was rolled back, and a browser must never
    // see seats change that did not. Neither step can fail the request (both only log).
    await this.expirations.schedule(outcome.id, outcome.holdUntil);
    this.seatEvents.held(input.showtimeId, outcome.seatIds, outcome.holdUntil);
    return { booking: await this.views.byId(outcome.id), created: true };
  }

  /** Steps of PLAN §4 inside one interactive transaction (READ COMMITTED). */
  private async holdInTransaction(
    tx: Tx,
    input: HoldInput,
    seatIds: string[],
    hash: string,
  ): Promise<HoldOutcome> {
    const now = this.clock.now();
    const { userId, showtimeId } = input;

    // Lock per (user, showtime) pair — NOT a seat lock. Two requests of the same user for the same
    // showtime run one after the other, so neither the key lookup nor the PENDING check below can
    // let both through.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text || ${showtimeId}::text))`;

    // A retry of a request that already went through: answer with that booking, whatever the
    // showtime or the seats look like now. Checked before anything else for that reason.
    const existing = await this.findByKey(tx, userId, input.idempotencyKey);
    if (existing) return { kind: 'existing', ...existing };

    // 1. The showtime exists and can be booked (read without a lock; checked again after step 2).
    const [showtime] = await tx.$queryRaw<ShowtimeRow[]>`
      SELECT room_id, status::text AS status, starts_at FROM showtimes WHERE id = ${showtimeId}::uuid`;
    if (!showtime) throw showtimeNotFound();
    const early = showtimeRefusal({ status: showtime.status, startsAt: showtime.starts_at }, now);
    if (early) throw showtimeRefused(early);

    // One PENDING booking per user per showtime while it can still be paid: a booking past its
    // expiresAt can no longer start a payment (PLAN §5), so it no longer blocks a new one. It keeps
    // its seats HELD until holdUntil (payment grace, for a late IPN of a payment already started):
    // the seat locks below refuse those seats (409 SEAT_UNAVAILABLE), other seats are fine. The
    // advisory lock above makes this check and the insert atomic per (user, showtime).
    const [pending] = await tx.$queryRaw<{ id: string; expires_at: Date }[]>`
      SELECT id, expires_at FROM bookings
      WHERE user_id = ${userId}::uuid AND showtime_id = ${showtimeId}::uuid
        AND status = 'PENDING' AND expires_at > ${now}
      ORDER BY expires_at DESC
      LIMIT 1`;
    if (pending) throw alreadyPending(pending);

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

    // 5. Seat prices are the ones locked into the showtime when it was created, not SeatPrice now.
    // 6. Combos: active ones only, name and unit price copied as they are right now.
    const combos = await this.comboSnapshot(tx, input.comboItems);
    const seatPrices = locked.map((row) => row.price);
    const { subtotal } = bookingTotals(seatPrices, combos);

    // 7. Voucher (ROADMAP 5.2): locked, checked and counted last, so a hold refused for its seats
    //    never queues for it. Any refusal throws and rolls back everything above.
    const voucher = input.voucherCode
      ? await this.voucherFor(tx, input.voucherCode, userId, subtotal, now)
      : null;
    const totals = bookingTotals(seatPrices, combos, voucher?.discount ?? 0);
    const { expiresAt, holdUntil } = holdDeadlines(
      now,
      this.holdTtlSeconds,
      this.paymentGraceSeconds,
    );

    // 8–9. Booking, seat lines, combo lines, voucher use. A concurrent request that already inserted this key
    //      makes the booking insert fail on unique(user_id, idempotency_key) — see hold().
    const booking = await tx.booking.create({
      data: {
        code: bookingCode(),
        userId,
        showtimeId,
        status: BookingStatus.PENDING,
        ...totals,
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
    if (combos.length > 0) {
      await tx.bookingCombo.createMany({
        data: combos.map((combo) => ({ bookingId: booking.id, ...combo })),
      });
    }
    if (voucher) {
      await tx.voucherUsage.create({
        data: {
          voucherId: voucher.id,
          userId,
          bookingId: booking.id,
          status: VoucherUsageStatus.RESERVED,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
    }

    // 10. Conditional update: a second line of defence behind the locks. Anything but one row per
    //    requested seat rolls the whole hold back.
    const updated = await tx.$executeRaw`
      UPDATE showtime_seats
      SET status = 'HELD', booking_id = ${booking.id}::uuid, held_until = ${holdUntil}
      WHERE showtime_id = ${showtimeId}::uuid AND seat_id = ANY(${seatIds}::uuid[])
        AND (status = 'AVAILABLE' OR (status = 'HELD' AND held_until <= ${now}))`;
    if (updated !== seatIds.length) throw seatUnavailable(seatIds);

    return { kind: 'created', id: booking.id, holdUntil, seatIds };
  }

  /**
   * Cancels one of the user's own bookings (`DELETE /bookings/:id`): a PENDING booking becomes
   * EXPIRED and its HELD seats go back to AVAILABLE at once instead of at holdUntil. An EXPIRED
   * booking is already over and is left as it is (idempotent). CONFIRMED and NEEDS_REVIEW are
   * `409 BOOKING_NOT_CANCELLABLE`; an unknown booking and another user's get the same `404`.
   * A PENDING booking with a SUCCESS payment is `409 BOOKING_NOT_CANCELLABLE` too, one with a
   * PENDING payment `409 BOOKING_HAS_PAYMENT_IN_PROGRESS`; FAILED and EXPIRED payments do not block.
   *
   * A cancelled booking is stored as EXPIRED: telling "cancelled by the user" from "ran out of
   * time" needs a new BookingStatus value, which waits for the owner (ROADMAP "Quyết định chờ").
   *
   * Locks, in the order of `expireBooking` (PLAN §4: Payment → Booking → ShowtimeSeat):
   * 1. the booking row `FOR UPDATE` — waits for an expiry running on the same booking (it holds
   *    the row for milliseconds); once that commits the booking is EXPIRED and this is a no-op.
   *    It also waits for a payment creation (`PaymentService.createVnpay`, FOR KEY SHARE on the
   *    same row, which conflicts with FOR UPDATE): the payments are read only after this lock, so
   *    a payment that committed first is always seen, and one that starts later waits for this
   *    cancel and then finds the booking EXPIRED;
   * 2. the booking's own HELD seats `FOR UPDATE ORDER BY seat_id`.
   * An expiry that comes second skips the booking (SKIP LOCKED), a hold never waits (NOWAIT) and a
   * showtime cancel never locks `bookings`, so no flow waits on this one in a cycle.
   */
  async cancel(userId: string, bookingId: string): Promise<void> {
    const released = await this.prisma.$transaction(async (tx) => {
      // 1. Only the owner's booking: another user's is "not found" as well (never 403).
      const [booking] = await tx.$queryRaw<{ status: BookingStatus; showtime_id: string }[]>`
        SELECT status::text AS status, showtime_id FROM bookings
        WHERE id = ${bookingId}::uuid AND user_id = ${userId}::uuid
        FOR UPDATE`;
      if (!booking) throw bookingNotFound();
      // 2. Already over (cancelled before, or expired by the worker): nothing to do.
      if (booking.status === BookingStatus.EXPIRED) return null;
      if (booking.status !== BookingStatus.PENDING) throw notCancellable();
      // 3. A paid booking is never cancelled; one with a payment still open at VNPay waits for its
      //    result. Read after the booking lock of step 1 and never before it: that lock is what
      //    keeps a payment creation (FOR KEY SHARE) from committing between this read and the
      //    update below, and the IPN (`confirmPayment`, Payment → Booking → Seats) takes the same
      //    booking row FOR UPDATE before it writes SUCCESS: while this cancel holds the row, a
      //    payment being confirmed is still PENDING here (→ 409); once the IPN committed, it is
      //    SUCCESS (→ 409). Without a lock on payments, so this never waits on the IPN's payment
      //    lock; a cancel that needs the payment locked must take it before the booking row
      //    (PLAN §4).
      const payments = await tx.$queryRaw<{ status: PaymentStatus }[]>`
        SELECT status::text AS status FROM payments WHERE booking_id = ${bookingId}::uuid`;
      if (payments.some((p) => p.status === PaymentStatus.SUCCESS)) throw notCancellable();
      if (payments.some((p) => p.status === PaymentStatus.PENDING)) throw paymentInProgress();

      // 4. The booking is over.
      await tx.$executeRaw`
        UPDATE bookings SET status = 'EXPIRED', updated_at = ${this.clock.now()}
        WHERE id = ${bookingId}::uuid AND status = 'PENDING'`;
      // 5. Its seats, in seat_id order like every other flow that locks seats.
      await tx.$queryRaw`
        SELECT seat_id FROM showtime_seats
        WHERE booking_id = ${bookingId}::uuid AND status = 'HELD'
        ORDER BY seat_id
        FOR UPDATE`;
      // 6. Only seats still HELD by this booking: past holdUntil another booking may already have
      //    taken one (lazy expiry), and a SOLD seat is never touched.
      const rows = await tx.$queryRaw<{ seat_id: string }[]>`
        UPDATE showtime_seats
        SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL
        WHERE booking_id = ${bookingId}::uuid AND status = 'HELD'
        RETURNING seat_id`;
      return { showtimeId: booking.showtime_id, seatIds: rows.map((row) => row.seat_id).sort() };
    }, CANCEL_TX);

    // 7. Only after the commit, and only when seats changed (SeatEvents skips an empty list).
    if (released) this.seatEvents.released(released.showtimeId, released.seatIds);
  }

  /**
   * The voucher of `code`, locked `FOR UPDATE`, checked and counted under that lock, and the
   * discount it gives this subtotal. The uses are counted after the lock, in a statement of their
   * own: under READ COMMITTED it sees every use committed by the holds that had the lock before,
   * so two holds can never both take the last use. Throws the refusal (409/422), or
   * `503 DATABASE_BUSY` when the lock is not free within VOUCHER_LOCK_TIMEOUT_MS.
   */
  private async voucherFor(
    tx: Tx,
    code: string,
    userId: string,
    subtotal: number,
    now: Date,
  ): Promise<{ id: string; discount: number }> {
    const lockTimeout = `${VOUCHER_LOCK_TIMEOUT_MS}ms`;
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
    let row: VoucherRow | undefined;
    try {
      [row] = await tx.$queryRaw<VoucherRow[]>`
        SELECT id, discount_type::text AS discount_type, discount_value, max_discount,
               min_subtotal, usage_limit, per_user_limit, starts_at, ends_at, is_active
        FROM vouchers WHERE code = ${code}
        FOR UPDATE`;
    } catch (error) {
      if (sqlStateOf(error) === SQLSTATE.lockNotAvailable) throw voucherBusy();
      throw error;
    }
    // No lock timeout again for the inserts that follow, like a hold without a voucher.
    await tx.$queryRaw`SELECT set_config('lock_timeout', '0', true)`;
    if (!row) throw voucherRefused({ code: 'VOUCHER_NOT_AVAILABLE' });

    const terms = {
      discountType: row.discount_type,
      discountValue: row.discount_value,
      maxDiscount: row.max_discount,
      minSubtotal: row.min_subtotal,
      usageLimit: row.usage_limit,
      perUserLimit: row.per_user_limit,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      isActive: row.is_active,
    };
    const refusal = voucherTermsRefusal(terms, now, subtotal);
    if (refusal) throw voucherRefused(refusal);

    // RELEASED uses (expired or cancelled bookings) gave their use back and do not count.
    const [used] = await tx.$queryRaw<{ total: number; by_user: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE user_id = ${userId}::uuid)::int AS by_user
      FROM voucher_usages
      WHERE voucher_id = ${row.id}::uuid AND status IN ('RESERVED', 'CONSUMED')`;
    const limit = voucherLimitRefusal(terms, {
      total: used?.total ?? 0,
      byUser: used?.by_user ?? 0,
    });
    if (limit) throw voucherRefused(limit);

    return { id: row.id, discount: voucherDiscount(terms, subtotal) };
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

  /**
   * BookingCombo rows to insert: name and price copied from active combos, in request order.
   * Not locked: an admin edit committing right after this read changes nothing for this booking,
   * which is the point of the snapshot.
   */
  private async comboSnapshot(tx: Tx, items: readonly ComboItemInput[]) {
    if (items.length === 0) return [];
    const combos = await tx.combo.findMany({
      where: { id: { in: items.map((item) => item.comboId) }, isActive: true },
      select: { id: true, name: true, price: true },
    });
    const byId = new Map(combos.map((combo) => [combo.id, combo]));
    const unavailable = items.filter((item) => !byId.has(item.comboId)).map((i) => i.comboId);
    if (unavailable.length > 0) throw comboNotAvailable(unavailable);
    return items.map((item) => {
      const combo = byId.get(item.comboId)!;
      return {
        comboId: combo.id,
        comboName: combo.name,
        unitPrice: combo.price,
        quantity: item.quantity,
      };
    });
  }

  private async findByKey(
    db: Db,
    userId: string,
    idempotencyKey: string,
  ): Promise<{ id: string; requestHash: string } | null> {
    return db.booking.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: { id: true, requestHash: true },
    });
  }
}

const toLockedSeat = (row: LockedRow): LockedSeatRow => ({
  seatId: row.seat_id,
  status: row.status,
  heldUntil: row.held_until,
});
