import { ApiProperty } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsUUID } from 'class-validator';

/** UUIDs are compared lower-case, like the booking ids of `POST /bookings`. */
const lowerCase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

/** Mirrors `createVnpayPaymentRequestSchema`. A malformed id is `400 VALIDATION_FAILED`. */
export class CreateVnpayPaymentDto {
  @ApiProperty({ description: "One of the user's PENDING bookings" })
  @Transform(lowerCase)
  @IsUUID('all')
  bookingId: string;
}
