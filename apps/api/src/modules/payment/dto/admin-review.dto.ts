import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { REVIEW_LIMITS, ReviewFilter } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { trimNfcValue } from '../../../common/dto/transforms';

/** Query of `GET /admin/bookings/needs-review`. Mirrors `REVIEW_LIMITS`. */
export class NeedsReviewQueryDto {
  @ApiPropertyOptional({ enum: ReviewFilter, default: ReviewFilter.OPEN })
  @IsOptional()
  @IsEnum(ReviewFilter)
  filter?: ReviewFilter;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: REVIEW_LIMITS.listPageSizeMax,
    default: REVIEW_LIMITS.listPageSizeDefault,
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(REVIEW_LIMITS.listPageSizeMax)
  pageSize?: number;
}

/**
 * Body of `POST /admin/bookings/:id/resolve-review`. Mirrors `resolveReviewRequestSchema`; the
 * note is required because it is the only record of what was actually done for the customer.
 */
export class ResolveReviewDto {
  @ApiProperty({ minLength: REVIEW_LIMITS.noteMin, maxLength: REVIEW_LIMITS.noteMax })
  @Transform(trimNfcValue)
  @IsString()
  @Length(REVIEW_LIMITS.noteMin, REVIEW_LIMITS.noteMax)
  note: string;
}
