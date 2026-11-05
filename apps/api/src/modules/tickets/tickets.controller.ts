import { Controller, Get, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  BookingErrorCode,
  BookingStatus,
  type TicketPdfLink,
  TICKET_LIMITS,
  TicketErrorCode,
} from '@ticketify/shared';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiException, validationFailed } from '../../common/errors/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TicketPdfStorage } from './ticket-pdf.storage';

function bookingId(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => validationFailed([{ field: 'id', messages: ['id must be a UUID'] }]),
  });
}

const bookingNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, BookingErrorCode.BOOKING_NOT_FOUND, 'Booking not found');

const notConfirmed = () =>
  apiException(
    HttpStatus.CONFLICT,
    TicketErrorCode.BOOKING_NOT_CONFIRMED,
    'Only a confirmed booking has tickets',
  );

const notReady = () =>
  apiException(
    HttpStatus.CONFLICT,
    TicketErrorCode.TICKET_PDF_NOT_READY,
    'The tickets are being prepared, please try again in a moment',
  );

/**
 * Downloading a booking's tickets (ROADMAP 4.5).
 *
 * The file is never streamed through the API: the answer is a short-lived presigned GET straight
 * to object storage, which keeps a 100 KB download off the API's event loop. The link is minutes
 * long and unguessable, and the API is what decides who gets one — the key itself
 * (`tickets/{bookingId}.pdf`) is guessable, so the bucket must stay private.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('bookings')
export class TicketsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfs: TicketPdfStorage,
  ) {}

  @Get(':id/ticket-pdf')
  @ApiOkResponse({
    description:
      "A presigned GET of the booking's ticket PDF, valid for " +
      `${TICKET_LIMITS.pdfUrlTtlSeconds} seconds`,
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: id is not a UUID' })
  @ApiNotFoundResponse({
    description: "BOOKING_NOT_FOUND: no such booking, or another user's (never 403)",
  })
  @ApiConflictResponse({
    description:
      'BOOKING_NOT_CONFIRMED: the booking has no tickets; ' +
      'TICKET_PDF_NOT_READY: confirmed, but the worker has not uploaded the file yet',
  })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_UNAVAILABLE' })
  async pdf(
    @CurrentUser() user: AuthUser,
    @Param('id', bookingId()) id: string,
  ): Promise<TicketPdfLink> {
    // Someone else's booking is "not found" as well, never a 403 (same rule as GET /bookings/:id).
    const booking = await this.prisma.booking.findFirst({
      where: { id, userId: user.id },
      select: { status: true },
    });
    if (!booking) throw bookingNotFound();
    if (booking.status !== BookingStatus.CONFIRMED) throw notConfirmed();
    if (!(await this.pdfs.exists(id))) throw notReady();
    return this.pdfs.link(id);
  }
}
