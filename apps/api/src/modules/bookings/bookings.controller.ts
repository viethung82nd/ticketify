import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { BOOKING_LIMITS, type Booking, type Page } from '@ticketify/shared';
import type { Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { validationFailed } from '../../common/errors/api-error';
import { BookingRateLimiter } from './booking-rate-limiter';
import { BookingViews } from './booking-views';
import { BookingService } from './booking.service';
import { HoldBookingDto } from './dto/hold-booking.dto';
import { MyBookingsQueryDto } from './dto/my-bookings-query.dto';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from './idempotency-key.decorator';

/** A malformed id is a format error like any other: `400 VALIDATION_FAILED`. */
const bookingId = new ParseUUIDPipe({
  exceptionFactory: () => validationFailed([{ field: 'id', messages: ['id must be a UUID'] }]),
});

/** What every booking response carries besides its own fields. */
const CONTEXT_NOTE =
  'Each booking carries movie { id, title, slug }, showtime { id, startsAt, endsAt } and ' +
  'room { id, name }, loaded with the booking (no extra request, no per-booking query)';

const EXPIRED_NOTE =
  '`expired` is true when the booking is PENDING past holdUntil (over, even if not yet marked ' +
  'EXPIRED); `status` is reported as stored';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingService,
    private readonly views: BookingViews,
    private readonly rateLimiter: BookingRateLimiter,
  ) {}

  @Post()
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      `${BOOKING_LIMITS.idempotencyKeyMin}–${BOOKING_LIMITS.idempotencyKeyMax} characters ` +
      '(A–Z a–z 0–9 . _ ~ : -), new for every booking attempt; resend it when retrying',
  })
  @ApiCreatedResponse({
    description: `Seats HELD until holdUntil; booking PENDING. ${CONTEXT_NOTE}`,
  })
  @ApiOkResponse({
    description:
      'Same Idempotency-Key and same payload as an earlier request: that booking, as it is now',
  })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED: body, seat count/duplicates, or the Idempotency-Key header',
  })
  @ApiNotFoundResponse({ description: 'SHOWTIME_NOT_FOUND' })
  @ApiConflictResponse({
    description:
      'SEAT_LOCKED, SEAT_UNAVAILABLE (details.seatIds), SHOWTIME_CANCELLED, BOOKING_ALREADY_PENDING',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'SEAT_NOT_FOUND, COUPLE_INCOMPLETE, SHOWTIME_STARTED, COMBO_NOT_AVAILABLE (details.comboIds), ' +
      'IDEMPOTENCY_KEY_REUSED (same key, different payload)',
  })
  @ApiTooManyRequestsResponse({
    description:
      'TOO_MANY_ATTEMPTS (details.retryAfterSeconds): BOOKING_RATE_LIMIT_MAX requests per user ' +
      'per BOOKING_RATE_LIMIT_WINDOW_SECONDS, retries included',
  })
  async hold(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body() dto: HoldBookingDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Booking> {
    // Before the hold transaction and its Idempotency-Key lookup: a refused request costs no DB.
    await this.rateLimiter.consume(user.id);
    const result = await this.bookings.hold({
      userId: user.id,
      showtimeId: dto.showtimeId,
      seatIds: dto.seatIds,
      comboItems: dto.comboItems ?? [],
      idempotencyKey,
    });
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.booking;
  }

  @Get(':id')
  @ApiOkResponse({
    description: `One of the user's bookings. ${CONTEXT_NOTE}. ${EXPIRED_NOTE}`,
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: id is not a UUID' })
  @ApiNotFoundResponse({
    description: "BOOKING_NOT_FOUND: no such booking, or another user's (never 403)",
  })
  get(@CurrentUser() user: AuthUser, @Param('id', bookingId) id: string): Promise<Booking> {
    return this.views.ofUser(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description:
      'PENDING → EXPIRED, its HELD seats AVAILABLE again and seat:released sent after commit. ' +
      'An EXPIRED booking (cancelled before, or expired) also answers 204 and changes nothing',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: id is not a UUID' })
  @ApiNotFoundResponse({
    description: "BOOKING_NOT_FOUND: no such booking, or another user's (never 403)",
  })
  @ApiConflictResponse({ description: 'BOOKING_NOT_CANCELLABLE: CONFIRMED or NEEDS_REVIEW' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', bookingId) id: string): Promise<void> {
    return this.bookings.cancel(user.id, id);
  }
}

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('me/bookings')
export class MyBookingsController {
  constructor(private readonly views: BookingViews) {}

  @Get()
  @ApiOkResponse({
    description: `The user's bookings, newest first (createdAt desc). ${CONTEXT_NOTE}. ${EXPIRED_NOTE}`,
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: status, page or pageSize (1–50)' })
  list(@CurrentUser() user: AuthUser, @Query() query: MyBookingsQueryDto): Promise<Page<Booking>> {
    return this.views.listOfUser(user.id, query);
  }
}
