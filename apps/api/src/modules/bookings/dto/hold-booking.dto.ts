import { ApiProperty } from '@nestjs/swagger';
import { BOOKING_LIMITS } from '@ticketify/shared';
import { Transform, type TransformFnParams } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** UUIDs are compared lower-case, so `A…` and `a…` are the same seat (duplicates, hash). */
const lowerCase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;
const lowerCaseEach = ({ value }: TransformFnParams): unknown =>
  Array.isArray(value)
    ? value.map((item: unknown) => (typeof item === 'string' ? item.toLowerCase() : item))
    : value;

/**
 * Mirrors `holdBookingRequestSchema`. Count, duplicates and format are value limits
 * (`400 VALIDATION_FAILED`); seat existence, couple pairs and availability need the database.
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
}
