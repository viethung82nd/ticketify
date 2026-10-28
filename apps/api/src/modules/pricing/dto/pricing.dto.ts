import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isHolidayDate, PRICING_LIMITS } from '@ticketify/shared';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min, ValidateBy } from 'class-validator';

/**
 * Mirrors `seatPriceRequestSchema`: an integer VND amount within PRICING_LIMITS. A value limit
 * is a format rule, so anything else is `400 VALIDATION_FAILED` (CONTRIBUTING.md, error codes).
 */
export class SeatPriceDto {
  @ApiProperty({
    description: 'VND per seat',
    minimum: PRICING_LIMITS.priceMin,
    maximum: PRICING_LIMITS.priceMax,
    example: 90_000,
  })
  @IsInt()
  @Min(PRICING_LIMITS.priceMin)
  @Max(PRICING_LIMITS.priceMax)
  price: number;
}

/** Mirrors `holidayRequestSchema`. */
export class HolidayDto {
  @ApiProperty({ example: '2026-09-02', description: 'Calendar date YYYY-MM-DD' })
  @ValidateBy({
    name: 'isHolidayDate',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isHolidayDate(value),
      defaultMessage: () =>
        `date must be YYYY-MM-DD with a year from ${PRICING_LIMITS.yearMin} to ${PRICING_LIMITS.yearMax}`,
    },
  })
  date: string;
}

export class ListHolidaysQueryDto {
  @ApiPropertyOptional({
    minimum: PRICING_LIMITS.yearMin,
    maximum: PRICING_LIMITS.yearMax,
    description: 'Defaults to the current year in the cinema time zone',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PRICING_LIMITS.yearMin)
  @Max(PRICING_LIMITS.yearMax)
  year?: number;
}
