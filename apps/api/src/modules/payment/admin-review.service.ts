import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  BookingStatus,
  type NeedsReviewBooking,
  type Page,
  PaymentStatus,
  REVIEW_LIMITS,
  ReviewErrorCode,
  ReviewFilter,
  seatLabel,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import type { Prisma } from '../../generated/prisma/client';
import { AuditAction, AuditEntity, writeAuditLog } from '../../infra/audit/audit-log';
import { ClockService } from '../../infra/clock/clock.service';
import { OutboxEventType } from '../../infra/outbox/outbox-events';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * One review resolution: a single conditional UPDATE and one audit row. It locks the booking row
 * only (`FOR NO KEY UPDATE`, as any UPDATE of a non-key column does), which does not conflict with
 * the `FOR KEY SHARE` a payment creation takes, and never locks a seat or a payment. Bounds are
 * small because nothing here waits on another flow.
 */
const RESOLVE_TX = { maxWait: 5_000, timeout: 10_000 } as const;

/** Relations one queue row shows. Prisma batches each level into one `IN (...)` select. */
const QUEUE_INCLUDE = {
  user: { select: { id: true, email: true, fullName: true, phone: true } },
  showtime: {
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      movie: { select: { title: true } },
      room: { select: { name: true } },
    },
  },
  seats: {
    select: { showtimeSeat: { select: { seat: { select: { row: true, number: true } } } } },
  },
  // At most one SUCCESS payment per booking (payments_booking_id_success_key).
  payments: {
    where: { status: PaymentStatus.SUCCESS },
    select: {
      id: true,
      txnRef: true,
      amount: true,
      status: true,
      vnpTransactionNo: true,
      bankCode: true,
      processedAt: true,
    },
  },
  reviewResolver: { select: { id: true, fullName: true } },
} satisfies Prisma.BookingInclude;

type QueueRow = Prisma.BookingGetPayload<{ include: typeof QUEUE_INCLUDE }>;

export interface NeedsReviewQuery {
  filter?: ReviewFilter;
  page?: number;
  pageSize?: number;
}

const bookingNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, ReviewErrorCode.BOOKING_NOT_FOUND, 'Booking not found');

/**
 * The admin side of `NEEDS_REVIEW` bookings (ROADMAP 3.8, PLAN §5 "Xử lý NEEDS_REVIEW"): the
 * queue of bookings that were paid but lost their seats, and the record that an admin handled one.
 *
 * **No refund happens here.** The money is returned by hand through the VNPay merchant portal, or
 * the customer is called; this service only stores who did it, when, and what they wrote
 * (`audit_logs`). Automatic refunds are out of scope (README).
 */
@Injectable()
export class AdminReviewService {
  private readonly logger = new Logger(AdminReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /**
   * One page of the queue. `open` (the default) is oldest first — the longest-waiting customer is
   * the most urgent; `resolved` and `all` are newest first.
   */
  async list(query: NeedsReviewQuery): Promise<Page<NeedsReviewBooking>> {
    const filter = query.filter ?? ReviewFilter.OPEN;
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      Math.max(1, query.pageSize ?? REVIEW_LIMITS.listPageSizeDefault),
      REVIEW_LIMITS.listPageSizeMax,
    );
    const where: Prisma.BookingWhereInput = {
      status: BookingStatus.NEEDS_REVIEW,
      ...(filter === ReviewFilter.OPEN ? { reviewResolvedAt: null } : {}),
      ...(filter === ReviewFilter.RESOLVED ? { reviewResolvedAt: { not: null } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        include: QUEUE_INCLUDE,
        orderBy: { createdAt: filter === ReviewFilter.OPEN ? 'asc' : 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const ids = rows.map((row) => row.id);
    const [reasons, notes] = await Promise.all([this.reasonsOf(ids), this.notesOf(ids)]);
    return {
      items: rows.map((row) =>
        this.view(row, reasons.get(row.id) ?? null, notes.get(row.id) ?? null),
      ),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Records that an admin handled `bookingId` outside the system. Idempotent only in the sense
   * that a second call is refused (`409 REVIEW_ALREADY_RESOLVED`): the note of the first one is
   * the account of what was done, and overwriting it would lose it.
   *
   * The booking's `status` stays `NEEDS_REVIEW` — this is an operational flag, not a state change
   * (adding a BookingStatus value is a separate decision, ROADMAP "Quyết định chờ").
   */
  async resolve(adminId: string, bookingId: string, note: string): Promise<NeedsReviewBooking> {
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      // One conditional UPDATE decides the race: two admins clicking at the same time cannot both
      // win, whatever either of them read a moment earlier.
      const updated = await tx.$executeRaw`
        UPDATE bookings
        SET review_resolved_at = ${now}, review_resolved_by = ${adminId}::uuid, updated_at = ${now}
        WHERE id = ${bookingId}::uuid AND status = 'NEEDS_REVIEW' AND review_resolved_at IS NULL`;
      if (updated !== 1) throw await this.whyNotResolvable(bookingId);

      await writeAuditLog(
        tx,
        {
          action: AuditAction.BOOKING_REVIEW_RESOLVED,
          entityType: AuditEntity.BOOKING,
          entityId: bookingId,
          actorId: adminId,
          note,
          // The booking's status is deliberately the same before and after: only the flag moved.
          before: { status: BookingStatus.NEEDS_REVIEW, reviewResolvedAt: null },
          after: {
            status: BookingStatus.NEEDS_REVIEW,
            reviewResolvedAt: now.toISOString(),
            reviewResolvedBy: adminId,
          },
        },
        now,
      );
    }, RESOLVE_TX);

    this.logger.log(
      `Admin ${adminId} marked NEEDS_REVIEW booking ${bookingId} handled; no refund was made by ` +
        `the system (manual, PLAN §5)`,
    );
    const row = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: QUEUE_INCLUDE,
    });
    if (!row) throw bookingNotFound();
    const [reasons, notes] = await Promise.all([
      this.reasonsOf([bookingId]),
      this.notesOf([bookingId]),
    ]);
    return this.view(row, reasons.get(bookingId) ?? null, notes.get(bookingId) ?? null);
  }

  /** Why the conditional UPDATE changed no row. Read after it, so the answer is the current state. */
  private async whyNotResolvable(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true, reviewResolvedAt: true },
    });
    if (!booking) return bookingNotFound();
    if (booking.status !== BookingStatus.NEEDS_REVIEW) {
      return apiException(
        HttpStatus.CONFLICT,
        ReviewErrorCode.BOOKING_NOT_IN_REVIEW,
        `Only a booking under review can be marked handled (this one is ${booking.status})`,
      );
    }
    return apiException(
      HttpStatus.CONFLICT,
      ReviewErrorCode.REVIEW_ALREADY_RESOLVED,
      'This booking was already marked handled',
      { resolvedAt: booking.reviewResolvedAt?.toISOString() ?? null },
    );
  }

  /** `reason` of each booking's newest `booking.needs_review` outbox event. */
  private async reasonsOf(bookingIds: readonly string[]): Promise<Map<string, string>> {
    if (bookingIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ booking_id: string; reason: string | null }[]>`
      SELECT DISTINCT ON (aggregate_id) aggregate_id AS booking_id, payload->>'reason' AS reason
      FROM outbox_events
      WHERE type = ${OutboxEventType.BOOKING_NEEDS_REVIEW}
        AND aggregate_id = ANY(${[...bookingIds]}::text[])
      ORDER BY aggregate_id, created_at DESC`;
    return new Map(
      rows.flatMap((row) => (row.reason ? [[row.booking_id, row.reason] as const] : [])),
    );
  }

  /** Note of each booking's newest `booking.review_resolved` audit entry. */
  private async notesOf(bookingIds: readonly string[]): Promise<Map<string, string>> {
    if (bookingIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ entity_id: string; note: string | null }[]>`
      SELECT DISTINCT ON (entity_id) entity_id, note
      FROM audit_logs
      WHERE entity_type = ${AuditEntity.BOOKING} AND action = ${AuditAction.BOOKING_REVIEW_RESOLVED}
        AND entity_id = ANY(${[...bookingIds]}::text[])
      ORDER BY entity_id, created_at DESC`;
    return new Map(rows.flatMap((row) => (row.note ? [[row.entity_id, row.note] as const] : [])));
  }

  private view(row: QueueRow, reason: string | null, note: string | null): NeedsReviewBooking {
    const payment = row.payments[0];
    return {
      bookingId: row.id,
      code: row.code,
      status: row.status,
      total: row.total,
      createdAt: row.createdAt.toISOString(),
      user: {
        id: row.user.id,
        email: row.user.email,
        fullName: row.user.fullName,
        phone: row.user.phone,
      },
      showtime: {
        id: row.showtime.id,
        startsAt: row.showtime.startsAt.toISOString(),
        endsAt: row.showtime.endsAt.toISOString(),
        status: row.showtime.status,
        movieTitle: row.showtime.movie.title,
        roomName: row.showtime.room.name,
      },
      seatLabels: row.seats
        .map((line) => seatLabel(line.showtimeSeat.seat))
        .sort((a, b) => a.localeCompare(b, 'en')),
      payment: payment
        ? {
            id: payment.id,
            txnRef: payment.txnRef,
            amount: payment.amount,
            status: payment.status,
            vnpTransactionNo: payment.vnpTransactionNo,
            bankCode: payment.bankCode,
            processedAt: payment.processedAt?.toISOString() ?? null,
          }
        : null,
      reason,
      resolution: row.reviewResolvedAt
        ? {
            at: row.reviewResolvedAt.toISOString(),
            byUserId: row.reviewResolver?.id ?? null,
            byName: row.reviewResolver?.fullName ?? null,
            note,
          }
        : null,
    };
  }
}
