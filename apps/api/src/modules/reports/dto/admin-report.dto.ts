import { ApiPropertyOptional } from '@nestjs/swagger';
import { ADMIN_REPORT_LIMITS, BookingStatus } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { blankToUndefined } from '../../../common/dto/transforms';
import { IsIsoDate } from '../../../common/dto/validators';

const toNumber = ({ value }: { value: unknown }): unknown =>
  value === undefined ? undefined : Number(value);

/**
 * Query of `GET /admin/bookings`. Mirrors `adminBookingsQuerySchema`; `from <= to` is checked by
 * the service (a rule across fields), also `400 VALIDATION_FAILED`.
 */
export class AdminBookingsQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({
    maxLength: ADMIN_REPORT_LIMITS.searchMax,
    description: 'Booking code (exact, any case) or part of the customer email',
  })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @MaxLength(ADMIN_REPORT_LIMITS.searchMax)
  q?: string;

  @ApiPropertyOptional({ description: 'Cinema day the booking was created on or after' })
  @IsOptional()
  @IsIsoDate()
  from?: string;

  @ApiPropertyOptional({ description: 'Cinema day the booking was created on or before' })
  @IsOptional()
  @IsIsoDate()
  to?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ADMIN_REPORT_LIMITS.listPageSizeMax,
    default: ADMIN_REPORT_LIMITS.listPageSizeDefault,
  })
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(ADMIN_REPORT_LIMITS.listPageSizeMax)
  pageSize?: number;
}

/** Query of `GET /admin/dashboard/revenue`. Mirrors `revenueQuerySchema`. */
export class RevenueQueryDto {
  @ApiPropertyOptional({
    description: 'First cinema day (YYYY-MM-DD); default: 6 days before `to`',
  })
  @IsOptional()
  @IsIsoDate()
  from?: string;

  @ApiPropertyOptional({ description: 'Last cinema day, included; default: today' })
  @IsOptional()
  @IsIsoDate()
  to?: string;
}

/** Query of `GET /admin/dashboard/occupancy`. Mirrors `occupancyQuerySchema`. */
export class OccupancyQueryDto {
  @ApiPropertyOptional({ description: 'Cinema day (YYYY-MM-DD); default: today' })
  @IsOptional()
  @IsIsoDate()
  date?: string;
}
