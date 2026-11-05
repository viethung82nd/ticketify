import { Injectable, Logger } from '@nestjs/common';
import {
  type CheckedTicket,
  CheckInResult,
  type CheckInResponse,
  TicketStatus,
} from '@ticketify/shared';
import { AppConfig } from '../../config/app-config.service';
import { ClockService } from '../../infra/clock/clock.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { readTicketToken } from './ticket-token';

/** What the check-in was asked to let in, and at which door. */
export interface CheckInInput {
  /** The whole QR payload, signature included. */
  token?: string;
  /** A code typed by hand (no signature to check). */
  code?: string;
  /** The showtime whose door is being watched; omitted means "any showtime". */
  showtimeId?: string;
  /** The staff member scanning, recorded on the ticket. */
  staffId: string;
}

interface TicketRow {
  code: string;
  status: TicketStatus;
  checked_in_at: Date | null;
  showtime_id: string;
  seat_row: string;
  seat_number: number;
  movie_title: string;
  room_name: string;
  starts_at: Date;
  booking_code: string;
}

const viewOf = (row: TicketRow, checkedInAt: Date | null, status: TicketStatus): CheckedTicket => ({
  code: row.code,
  seatLabel: `${row.seat_row}${row.seat_number}`,
  status,
  movieTitle: row.movie_title,
  roomName: row.room_name,
  showtimeStartsAt: row.starts_at.toISOString(),
  showtimeId: row.showtime_id,
  bookingCode: row.booking_code,
  checkedInAt: checkedInAt?.toISOString() ?? null,
});

/**
 * Checking one ticket in at the door (PLAN §7, ROADMAP 4.7).
 *
 * The decision is made by one statement:
 * `UPDATE tickets SET status = 'CHECKED_IN' … WHERE code = $1 AND status = 'ISSUED'`.
 * Two doors scanning the same ticket at the same moment therefore produce exactly one `OK` and
 * one `ALREADY_USED`, with no lock and no transaction — the row's own state is the arbiter.
 *
 * The showtime is checked before that statement, so a ticket shown at the wrong door is reported
 * and left untouched, ready for its own door.
 *
 * A signed QR token is only a cheap filter: a forged or mistyped code is refused without touching
 * the database. It grants nothing by itself — the status check above is what lets someone in.
 */
@Injectable()
export class CheckInService {
  private readonly logger = new Logger(CheckInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
  ) {}

  async check(input: CheckInInput): Promise<CheckInResponse> {
    const code = this.codeOf(input);
    if (!code) return { result: CheckInResult.NOT_FOUND };

    const ticket = await this.read(code);
    if (!ticket) return { result: CheckInResult.NOT_FOUND };

    if (input.showtimeId && ticket.showtime_id !== input.showtimeId) {
      return {
        result: CheckInResult.WRONG_SHOWTIME,
        ticket: viewOf(ticket, ticket.checked_in_at, ticket.status),
      };
    }
    if (ticket.status === TicketStatus.VOID) {
      return { result: CheckInResult.VOID, ticket: viewOf(ticket, null, ticket.status) };
    }

    const now = this.clock.now();
    const [checked] = await this.prisma.$queryRaw<{ checked_in_at: Date }[]>`
      UPDATE tickets
      SET status = 'CHECKED_IN', checked_in_at = ${now}, checked_in_by_id = ${input.staffId}::uuid,
          updated_at = ${now}
      WHERE code = ${code} AND status = 'ISSUED'
      RETURNING checked_in_at`;
    if (checked) {
      this.logger.log(`Check-in ${code} (booking ${ticket.booking_code}) by ${input.staffId}`);
      return {
        result: CheckInResult.OK,
        ticket: viewOf(ticket, checked.checked_in_at, TicketStatus.CHECKED_IN),
      };
    }

    // The update changed nothing: it was already checked in, here or at another door a moment ago.
    const again = (await this.read(code)) ?? ticket;
    this.logger.warn(
      `Check-in ${code} (booking ${ticket.booking_code}) refused: already ${again.status}`,
    );
    return {
      result: again.status === TicketStatus.VOID ? CheckInResult.VOID : CheckInResult.ALREADY_USED,
      ticket: viewOf(again, again.checked_in_at, again.status),
    };
  }

  /** The ticket code behind the request, or `undefined` for a token that does not check out. */
  private codeOf(input: CheckInInput): string | undefined {
    if (input.token) {
      return readTicketToken(input.token, this.config.get('TICKET_QR_SECRET')) ?? undefined;
    }
    return input.code?.trim().toUpperCase();
  }

  private async read(code: string): Promise<TicketRow | undefined> {
    const [row] = await this.prisma.$queryRaw<TicketRow[]>`
      SELECT t.code, t.status::text AS status, t.checked_in_at, t.showtime_id,
             s.row AS seat_row, s.number AS seat_number,
             m.title AS movie_title, r.name AS room_name, st.starts_at, b.code AS booking_code
      FROM tickets t
      JOIN seats s ON s.id = t.seat_id
      JOIN showtimes st ON st.id = t.showtime_id
      JOIN movies m ON m.id = st.movie_id
      JOIN rooms r ON r.id = st.room_id
      JOIN bookings b ON b.id = t.booking_id
      WHERE t.code = ${code}`;
    return row;
  }
}
