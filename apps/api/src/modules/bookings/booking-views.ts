import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BOOKING_LIMITS,
  type BookingCombo,
  BookingErrorCode,
  type BookingStatus,
  type Booking as BookingView,
  type Page,
  seatLabel,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import type { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { isHoldExpired } from './booking-rules';

const bookingNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, BookingErrorCode.BOOKING_NOT_FOUND, 'Booking not found');

/**
 * Everything a booking response shows, in one query: Prisma batches each relation level into a
 * single `IN (...)` select, so a page of bookings costs one select per relation, not one per row.
 */
const VIEW_INCLUDE = {
  showtime: {
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      movie: { select: { id: true, title: true, slug: true } },
      room: { select: { id: true, name: true } },
    },
  },
  seats: {
    include: {
      showtimeSeat: { select: { seat: { select: { row: true, number: true, type: true } } } },
    },
  },
  combos: { orderBy: { id: 'asc' } },
} satisfies Prisma.BookingInclude;

type BookingWithLines = Prisma.BookingGetPayload<{ include: typeof VIEW_INCLUDE }>;

export interface MyBookingsQuery {
  status?: BookingStatus;
  page?: number;
  pageSize?: number;
}

/** Bookings as the API returns them (`POST /bookings`, `GET /bookings/:id`, `GET /me/bookings`). */
@Injectable()
export class BookingViews {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async byId(id: string): Promise<BookingView> {
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id },
      include: VIEW_INCLUDE,
    });
    return this.toView(booking);
  }

  /** One booking of `userId`. Someone else's booking is a 404 as well, never a 403. */
  async ofUser(userId: string, id: string): Promise<BookingView> {
    const booking = await this.prisma.booking.findFirst({
      where: { id, userId },
      include: VIEW_INCLUDE,
    });
    if (!booking) throw bookingNotFound();
    return this.toView(booking);
  }

  /** The user's bookings, newest first, optionally of one status (as stored). */
  async listOfUser(userId: string, query: MyBookingsQuery): Promise<Page<BookingView>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? BOOKING_LIMITS.listPageSizeDefault;
    const where: Prisma.BookingWhereInput = { userId, status: query.status };
    const [total, bookings] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        include: VIEW_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const now = this.clock.now();
    return { items: bookings.map((b) => this.toView(b, now)), total, page, pageSize };
  }

  /** Seats by row then number, combo lines by id. */
  private toView(booking: BookingWithLines, now = this.clock.now()): BookingView {
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
    const combos: BookingCombo[] = booking.combos.map((line) => ({
      comboId: line.comboId,
      name: line.comboName,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      amount: line.unitPrice * line.quantity,
    }));
    const { showtime } = booking;
    return {
      id: booking.id,
      code: booking.code,
      showtimeId: booking.showtimeId,
      movie: showtime.movie,
      showtime: {
        id: showtime.id,
        startsAt: showtime.startsAt.toISOString(),
        endsAt: showtime.endsAt.toISOString(),
      },
      room: showtime.room,
      status: booking.status,
      expiresAt: booking.expiresAt.toISOString(),
      holdUntil: booking.holdUntil.toISOString(),
      expired: isHoldExpired(booking, now),
      seats,
      combos,
      subtotal: booking.subtotal,
      discount: booking.discount,
      total: booking.total,
      createdAt: booking.createdAt.toISOString(),
    };
  }
}
