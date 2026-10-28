import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { COMBO_LIMITS } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trimNfcBlankToNull, trimNfcValue } from '../../../common/dto/transforms';
import { OptionalNotNull } from '../../../common/dto/validators';

/**
 * Mirrors `createComboRequestSchema`. Name length and price range are value limits, so breaking
 * them is `400 VALIDATION_FAILED`; a duplicate name is a business rule (`409 COMBO_NAME_TAKEN`).
 */
export class CreateComboDto {
  @ApiProperty({ example: 'Combo bắp nước', maxLength: COMBO_LIMITS.nameMax })
  @Transform(trimNfcValue)
  @IsString()
  @Length(1, COMBO_LIMITS.nameMax)
  name: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: COMBO_LIMITS.descriptionMax,
    description: 'Blank is stored as null',
  })
  @Transform(trimNfcBlankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(COMBO_LIMITS.descriptionMax)
  description?: string | null;

  @ApiProperty({
    description: 'VND',
    minimum: COMBO_LIMITS.priceMin,
    maximum: COMBO_LIMITS.priceMax,
    example: 89_000,
  })
  @IsInt()
  @Min(COMBO_LIMITS.priceMin)
  @Max(COMBO_LIMITS.priceMax)
  price: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Mirrors `updateComboRequestSchema`. Omitted fields stay; `description: null` clears it. */
export class UpdateComboDto {
  @ApiPropertyOptional({ maxLength: COMBO_LIMITS.nameMax })
  @Transform(trimNfcValue)
  @OptionalNotNull()
  @IsString()
  @Length(1, COMBO_LIMITS.nameMax)
  name?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: COMBO_LIMITS.descriptionMax })
  @Transform(trimNfcBlankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(COMBO_LIMITS.descriptionMax)
  description?: string | null;

  @ApiPropertyOptional({ minimum: COMBO_LIMITS.priceMin, maximum: COMBO_LIMITS.priceMax })
  @OptionalNotNull()
  @IsInt()
  @Min(COMBO_LIMITS.priceMin)
  @Max(COMBO_LIMITS.priceMax)
  price?: number;

  @ApiPropertyOptional({ description: 'false hides it from customers; bookings keep their copy' })
  @OptionalNotNull()
  @IsBoolean()
  isActive?: boolean;
}
