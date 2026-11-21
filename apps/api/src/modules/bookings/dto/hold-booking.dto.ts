import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BOOKING_LIMITS,
  normalizeVoucherCode,
  VOUCHER_CODE_PATTERN,
  VOUCHER_LIMITS,
} from '@ticketify/shared';
import { Transform, type TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** UUIDs are compared lower-case, so `A…` and `a…` are the same seat (duplicates, hash). */
const lowerCase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;
/** Voucher codes are stored upper-case: " summer10 " is SUMMER10 (as in the admin DTO). */
const voucherCode = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? normalizeVoucherCode(value) : value;
const lowerCaseEach = ({ value }: TransformFnParams): unknown =>
  Array.isArray(value)
    ? value.map((item: unknown) => (typeof item === 'string' ? item.toLowerCase() : item))
    : value;

/** Mirrors `comboItemSchema`. */
export class ComboItemDto {
  @ApiProperty()
  @Transform(lowerCase)
  @IsUUID('all')
  comboId: string;

  @ApiProperty({ minimum: 1, maximum: BOOKING_LIMITS.comboQuantityMax })
  @IsInt()
  @Min(1)
  @Max(BOOKING_LIMITS.comboQuantityMax)
  quantity: number;
}

/**
 * Mirrors `holdBookingRequestSchema`. Count, duplicates and format are value limits
 * (`400 VALIDATION_FAILED`), and so is a malformed `voucherCode`; seat existence, couple pairs,
 * availability, combos being on sale and whether the voucher applies need the database.
 */
export class HoldBookingDto {
  @ApiProperty()
  @Transform(lowerCase)
  @IsUUID('all')
  showtimeId: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: BOOKING_LIMITS.seatsMax,
    description: 'Seat ids (not ShowtimeSeat ids); both seats of a couple pair together',
  })
  @Transform(lowerCaseEach)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BOOKING_LIMITS.seatsMax)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  seatIds: string[];

  @ApiPropertyOptional({
    type: [ComboItemDto],
    maxItems: BOOKING_LIMITS.comboLinesMax,
    description: 'Active combos; one line per combo (default: none)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BOOKING_LIMITS.comboLinesMax)
  @ArrayUnique((item: ComboItemDto) => item?.comboId)
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  comboItems?: ComboItemDto[];

  @ApiPropertyOptional({
    example: 'SUMMER10',
    minLength: VOUCHER_LIMITS.codeMin,
    maxLength: VOUCHER_LIMITS.codeMax,
    description:
      'Voucher to apply; trimmed and upper-cased. The API computes the discount and reserves ' +
      'one use of the voucher with the seats (ROADMAP 5.2)',
  })
  @Transform(voucherCode)
  @IsOptional()
  @IsString()
  @Length(VOUCHER_LIMITS.codeMin, VOUCHER_LIMITS.codeMax)
  @Matches(VOUCHER_CODE_PATTERN, { message: 'voucherCode may contain only letters A-Z and digits' })
  voucherCode?: string;
}
