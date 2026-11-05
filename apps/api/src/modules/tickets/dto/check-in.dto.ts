import { ApiPropertyOptional } from '@nestjs/swagger';
import { TICKET_LIMITS } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { trimValue } from '../../../common/dto/transforms';

/** Trims and upper-cases a hand-typed code, so `k7px…` and ` K7PX… ` both work. */
const upperTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * Body of `POST /tickets/check-in`: either the whole QR payload (`token`) or a code typed by
 * hand (`code`), never both — a device that has a scan has nothing to type, and sending both
 * would leave the server guessing which one the person meant.
 */
export class CheckInDto {
  @ApiPropertyOptional({
    description: 'The whole QR payload: {code}.{signature}. Mutually exclusive with `code`',
  })
  @ValidateIf((dto: CheckInDto) => dto.code === undefined)
  @IsString()
  @Length(1, 200)
  @Transform(trimValue)
  token?: string;

  @ApiPropertyOptional({
    description: `A ticket code typed by hand (${TICKET_LIMITS.codeLength} characters, case-insensitive)`,
  })
  @ValidateIf((dto: CheckInDto) => dto.token === undefined)
  @IsString()
  @Length(1, 64)
  @Transform(upperTrim)
  code?: string;

  @ApiPropertyOptional({
    description: 'The showtime whose door is being watched; omit to accept any showtime',
  })
  @IsOptional()
  @IsUUID()
  showtimeId?: string;
}
