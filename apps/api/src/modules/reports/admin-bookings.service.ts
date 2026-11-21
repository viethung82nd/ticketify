import { Injectable } from '@nestjs/common';
import {
  ADMIN_REPORT_LIMITS,
  type AdminBooking,
  type BookingStatus,
  cinemaDayRange,
  type Page,
  seatLabel,
} from '@ticketify/shared';
import { validationFailed } from '../../common/errors/api-error';
import { AppConfig } from '../../config/app-config.service';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Relations one row of the list shows. Prisma batches each level into one `IN (...)` select. */
const ROW_INCLUDE = {
  user: { select: { id: true, email: true, fullName: true } },
  showtime: {
    select: {
      id: true,
      startsAt: true,
      movie: { select: { title: true } },
      room: { select: { name: true } },
    },
  },
  seats: {
    select: { showtimeSeat: { select: { seat: { select: { row: true, number: true } } } } },
  },
  // Newest attempt only: what the customer did last.
  payments: { select: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
  voucherUsage: { select: { voucher: { select: { code: true } } } },
} satisfies Prisma.BookingInclude;

type Row = Prisma.BookingGetPayload<{ include: typeof ROW_INCLUDE }>;

export interface AdminBookingsQuery {
  status?: BookingStatus;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Every booking, for the admin (ROADMAP 5.5): newest first, filtered by status, by the cinema day
 * it was created on, and by a search on the booking code or the customer's email. Read only.
 */
@Injectable()
export class AdminBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async list(query: AdminBookingsQuery): Promise<Page<AdminBooking>> {
    if (query.from && query.to && query.from > query.to) {
      throw validationFailed([
        { field: 'to', messages: ['to must be the same day as from or later'] },
      ]);
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ADMIN_REPORT_LIMITS.listPageSizeDefault;
    const timeZone = this.config.get('CINEMA_TZ');

    const where: Prisma.BookingWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: cinemaDayRange(query.from, timeZone).from } : {}),
              ...(query.to ? { lt: cinemaDayRange(query.to, timeZone).to } : {}),
            },
          }
        : {}),
      ...(query.q ? { OR: this.search(query.q) } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        include: ROW_INCLUDE,
        // Ids are UUIDv7: a tie on createdAt still sorts newest first, and pages never overlap.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map((row) => this.view(row)), total, page, pageSize };
  }

  /**
   * The booking code exactly (codes are upper case, `bookingCode()`) or part of the email (emails
   * are stored lower case). Prisma does **not** escape LIKE wildcards in `contains` (measured: `%`
   * matched every booking), so `\`, `%` and `_` are escaped here and match themselves.
   */
  private search(q: string): Prisma.BookingWhereInput[] {
    const literal = q.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`);
    return [{ code: q.toUpperCase() }, { user: { email: { contains: literal } } }];
  }

  private view(row: Row): AdminBooking {
    return {
      id: row.id,
      code: row.code,
      status: row.status,
      subtotal: row.subtotal,
      discount: row.discount,
      total: row.total,
      voucherCode: row.voucherUsage?.voucher.code ?? null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      user: { id: row.user.id, email: row.user.email, fullName: row.user.fullName },
      showtime: {
        id: row.showtime.id,
        startsAt: row.showtime.startsAt.toISOString(),
        movieTitle: row.showtime.movie.title,
        roomName: row.showtime.room.name,
      },
      seatLabels: row.seats
        .map((line) => seatLabel(line.showtimeSeat.seat))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      paymentStatus: row.payments[0]?.status ?? null,
    };
  }
}
