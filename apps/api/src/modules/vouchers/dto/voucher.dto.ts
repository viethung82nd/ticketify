import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  normalizeVoucherCode,
  VOUCHER_CODE_PATTERN,
  VOUCHER_LIMITS,
  VoucherDiscountType,
} from '@ticketify/shared';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trimNfcBlankToNull } from '../../../common/dto/transforms';
import { IsIsoInstant, OptionalNotNull } from '../../../common/dto/validators';

const DISCOUNT_TYPES = Object.values(VoucherDiscountType);

/** Trims and upper-cases a string; anything else is left to the validators. */
const codeValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeVoucherCode(value) : value;

/**
 * Mirrors `createVoucherRequestSchema`. Each field's own range is a value limit, so breaking it is
 * `400 VALIDATION_FAILED`. The rules across fields (`voucherRuleErrors`: discount range by type,
 * a cap only for PERCENT, endsAt after startsAt) are checked by the service, with the same `400`.
 * A code already in use is a business rule (`409 VOUCHER_CODE_TAKEN`).
 */
export class CreateVoucherDto {
  @ApiProperty({
    example: 'SUMMER10',
    minLength: VOUCHER_LIMITS.codeMin,
    maxLength: VOUCHER_LIMITS.codeMax,
    description: 'Letters A–Z and digits; trimmed and upper-cased before it is checked',
  })
  @Transform(codeValue)
  @IsString()
  @Length(VOUCHER_LIMITS.codeMin, VOUCHER_LIMITS.codeMax)
  @Matches(VOUCHER_CODE_PATTERN, { message: 'code may contain only letters A-Z and digits' })
  code: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: VOUCHER_LIMITS.descriptionMax,
    description: 'Blank is stored as null',
  })
  @Transform(trimNfcBlankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(VOUCHER_LIMITS.descriptionMax)
  description?: string | null;

  @ApiProperty({ enum: DISCOUNT_TYPES })
  @IsIn(DISCOUNT_TYPES)
  discountType: VoucherDiscountType;

  @ApiProperty({
    description: `PERCENT: ${VOUCHER_LIMITS.percentMin}–${VOUCHER_LIMITS.percentMax} (%). FIXED: ${VOUCHER_LIMITS.fixedMin}–${VOUCHER_LIMITS.fixedMax} (VND)`,
    example: 10,
  })
  @IsInt()
  @Min(VOUCHER_LIMITS.percentMin)
  @Max(VOUCHER_LIMITS.fixedMax)
  discountValue: number;

  @ApiPropertyOptional({
    nullable: true,
    minimum: VOUCHER_LIMITS.maxDiscountMin,
    maximum: VOUCHER_LIMITS.maxDiscountMax,
    description: 'VND cap of a PERCENT discount; null or left out = no cap. Must be null for FIXED',
  })
  @IsOptional()
  @IsInt()
  @Min(VOUCHER_LIMITS.maxDiscountMin)
  @Max(VOUCHER_LIMITS.maxDiscountMax)
  maxDiscount?: number | null;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    maximum: VOUCHER_LIMITS.minSubtotalMax,
    description: 'Smallest booking subtotal (VND) it applies to',
  })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(VOUCHER_LIMITS.minSubtotalMax)
  minSubtotal?: number;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    maximum: VOUCHER_LIMITS.usageLimitMax,
    description: 'Uses across all users; null or left out = unlimited',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VOUCHER_LIMITS.usageLimitMax)
  usageLimit?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    maximum: VOUCHER_LIMITS.perUserLimitMax,
    default: VOUCHER_LIMITS.perUserLimitDefault,
    description: `Uses per user; null = unlimited, left out = ${VOUCHER_LIMITS.perUserLimitDefault}`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VOUCHER_LIMITS.perUserLimitMax)
  perUserLimit?: number | null;

  @ApiProperty({ example: '2026-12-01T00:00:00+07:00' })
  @IsIsoInstant()
  startsAt: string;

  @ApiProperty({ example: '2027-01-01T00:00:00+07:00', description: 'Must be after startsAt' })
  @IsIsoInstant()
  endsAt: string;

  @ApiPropertyOptional({ default: true })
  @OptionalNotNull()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Mirrors `updateVoucherRequestSchema`. Omitted fields stay; `null` clears the nullable ones
 * (description, maxDiscount, usageLimit, perUserLimit). The rules across fields are checked on
 * the voucher as it would be after the change.
 */
export class UpdateVoucherDto {
  @ApiPropertyOptional({ minLength: VOUCHER_LIMITS.codeMin, maxLength: VOUCHER_LIMITS.codeMax })
  @Transform(codeValue)
  @OptionalNotNull()
  @IsString()
  @Length(VOUCHER_LIMITS.codeMin, VOUCHER_LIMITS.codeMax)
  @Matches(VOUCHER_CODE_PATTERN, { message: 'code may contain only letters A-Z and digits' })
  code?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: VOUCHER_LIMITS.descriptionMax })
  @Transform(trimNfcBlankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(VOUCHER_LIMITS.descriptionMax)
  description?: string | null;

  @ApiPropertyOptional({ enum: DISCOUNT_TYPES })
  @OptionalNotNull()
  @IsIn(DISCOUNT_TYPES)
  discountType?: VoucherDiscountType;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsInt()
  @Min(VOUCHER_LIMITS.percentMin)
  @Max(VOUCHER_LIMITS.fixedMax)
  discountValue?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(VOUCHER_LIMITS.maxDiscountMin)
  @Max(VOUCHER_LIMITS.maxDiscountMax)
  maxDiscount?: number | null;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(VOUCHER_LIMITS.minSubtotalMax)
  minSubtotal?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VOUCHER_LIMITS.usageLimitMax)
  usageLimit?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VOUCHER_LIMITS.perUserLimitMax)
  perUserLimit?: number | null;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsIsoInstant()
  startsAt?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsIsoInstant()
  endsAt?: string;

  @ApiPropertyOptional({ description: 'false stops new uses; bookings keep their discount' })
  @OptionalNotNull()
  @IsBoolean()
  isActive?: boolean;
}
