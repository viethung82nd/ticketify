import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { BOOKING_LIMITS, type Booking } from '@ticketify/shared';
import type { Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { BookingService } from './booking.service';
import { HoldBookingDto } from './dto/hold-booking.dto';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from './idempotency-key.decorator';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      `${BOOKING_LIMITS.idempotencyKeyMin}–${BOOKING_LIMITS.idempotencyKeyMax} characters ` +
      '(A–Z a–z 0–9 . _ ~ : -), new for every booking attempt; resend it when retrying',
  })
  @ApiCreatedResponse({ description: 'Seats HELD until holdUntil; booking PENDING' })
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
  async hold(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body() dto: HoldBookingDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Booking> {
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
}
