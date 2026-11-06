import { Injectable } from '@nestjs/common';
import { type SeatType, seatLabel, type TicketStatus } from '@ticketify/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** One ticket of a booking, with the seat it is for. */
export interface DeliveryTicket {
  id: string;
  code: string;
  seatId: string;
  seatLabel: string;
  seatType: SeatType;
  status: TicketStatus;
}

/**
 * Everything the delivery steps need about one booking: the notification text (4.2), the PDF
 * (4.4) and the email (4.6) all describe the same thing, so they read it the same way.
 */
export interface DeliveryBooking {
  id: string;
  code: string;
  total: number;
  /** Set once the confirmation email went out; `send-email` skips a booking that has it. */
  emailSentAt: Date | null;
  user: { id: string; email: string; fullName: string };
  movie: { title: string };
  showtime: { id: string; startsAt: Date; endsAt: Date };
  room: { name: string };
  /** Seats of the booking, by row then number. */
  seats: { seatId: string; label: string; type: SeatType; price: number }[];
  /** ISSUED (or checked-in) tickets, by seat; empty for a booking under review. */
  tickets: DeliveryTicket[];
}

/** A booking the delivery steps were asked about no longer exists (deleted test data...). */
export class BookingGoneError extends Error {
  constructor(bookingId: string) {
    super(`Booking ${bookingId} no longer exists`);
    this.name = 'BookingGoneError';
  }
}

/**
 * Reads one booking for the delivery pipeline, in a single query (Prisma batches the relations).
 * Outside any transaction: the payment transaction has long committed, and nothing here writes.
 */
@Injectable()
export class BookingDelivery {
  constructor(private readonly prisma: PrismaService) {}

  async read(bookingId: string): Promise<DeliveryBooking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        code: true,
        total: true,
        emailSentAt: true,
        user: { select: { id: true, email: true, fullName: true } },
        showtime: {
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            movie: { select: { title: true } },
            room: { select: { name: true } },
          },
        },
        seats: {
          select: {
            seatId: true,
            price: true,
            showtimeSeat: { select: { seat: { select: { row: true, number: true, type: true } } } },
          },
        },
        tickets: {
          select: {
            id: true,
            code: true,
            seatId: true,
            status: true,
            showtimeSeat: { select: { seat: { select: { row: true, number: true, type: true } } } },
          },
        },
      },
    });
    if (!booking) throw new BookingGoneError(bookingId);

    const seats = booking.seats
      .map((line) => ({
        seatId: line.seatId,
        label: seatLabel(line.showtimeSeat.seat),
        type: line.showtimeSeat.seat.type,
        price: line.price,
      }))
      .sort(byLabel);
    const tickets = booking.tickets
      .map((ticket) => ({
        id: ticket.id,
        code: ticket.code,
        seatId: ticket.seatId,
        label: seatLabel(ticket.showtimeSeat.seat),
        seatType: ticket.showtimeSeat.seat.type,
        status: ticket.status,
      }))
      .sort(byLabel)
      .map(({ label, ...ticket }) => ({ ...ticket, seatLabel: label }));

    return {
      id: booking.id,
      code: booking.code,
      total: booking.total,
      emailSentAt: booking.emailSentAt,
      user: booking.user,
      movie: booking.showtime.movie,
      showtime: {
        id: booking.showtime.id,
        startsAt: booking.showtime.startsAt,
        endsAt: booking.showtime.endsAt,
      },
      room: booking.showtime.room,
      seats,
      tickets,
    };
  }
}

/** A1, A2, … A10, B1 — the order a person reads seats in, not the lexicographic one. */
const byLabel = (a: { label: string }, b: { label: string }): number => {
  const parts = (label: string): [string, number] => {
    const match = /^([A-Z]+)(\d+)$/.exec(label);
    return match ? [match[1]!, Number(match[2])] : [label, 0];
  };
  const [rowA, numberA] = parts(a.label);
  const [rowB, numberB] = parts(b.label);
  return rowA.localeCompare(rowB) || numberA - numberB;
};
