import { ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_LIMITS } from '@ticketify/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** `?unread=true` only; anything else (absent, `false`) means "every notification". */
const trueOnly = ({ value }: { value: unknown }): unknown =>
  value === 'true' || value === true
    ? true
    : value === 'false' || value === undefined
      ? undefined
      : value;

/** Query of `GET /me/notifications`. Out-of-range values are `400 VALIDATION_FAILED`. */
export class MyNotificationsQueryDto {
  @ApiPropertyOptional({
    description: 'true = only unread ones; omitted or false = all of them',
    type: Boolean,
  })
  @IsOptional()
  @Transform(trueOnly)
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: NOTIFICATION_LIMITS.listPageSizeMax,
    default: NOTIFICATION_LIMITS.listPageSizeDefault,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTIFICATION_LIMITS.listPageSizeMax)
  pageSize?: number;
}
