import { ApiPropertyOptional } from '@nestjs/swagger';
import { BOOKING_LIMITS, BookingStatus } from '@ticketify/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

const BOOKING_STATUSES = Object.values(BookingStatus);

/** Query of `GET /me/bookings`. Out-of-range values are `400 VALIDATION_FAILED`. */
export class MyBookingsQueryDto {
  @ApiPropertyOptional({ enum: BOOKING_STATUSES, description: 'Status as stored' })
  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: BookingStatus;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: BOOKING_LIMITS.listPageSizeMax,
    default: BOOKING_LIMITS.listPageSizeDefault,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BOOKING_LIMITS.listPageSizeMax)
  pageSize?: number;
}
