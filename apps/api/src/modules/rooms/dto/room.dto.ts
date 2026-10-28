import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROOM_LIMITS, SeatType } from '@ticketify/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { trimNfcValue } from '../../../common/dto/transforms';
import { OptionalNotNull } from '../../../common/dto/validators';

const SEAT_TYPES = Object.values(SeatType);

/** Mirrors `renameRoomRequestSchema`. */
export class RenameRoomDto {
  @ApiProperty({ example: 'Phòng 2', maxLength: ROOM_LIMITS.nameMax })
  @Transform(trimNfcValue)
  @IsString()
  @Length(1, ROOM_LIMITS.nameMax)
  name: string;
}

/** Mirrors `createRoomRequestSchema`. */
export class CreateRoomDto extends RenameRoomDto {
  @ApiProperty({
    minimum: ROOM_LIMITS.rowsMin,
    maximum: ROOM_LIMITS.rowsMax,
    description: 'Rows, labelled A–Z',
  })
  @IsInt()
  @Min(ROOM_LIMITS.rowsMin)
  @Max(ROOM_LIMITS.rowsMax)
  rows: number;

  @ApiProperty({ minimum: ROOM_LIMITS.colsMin, maximum: ROOM_LIMITS.colsMax })
  @IsInt()
  @Min(ROOM_LIMITS.colsMin)
  @Max(ROOM_LIMITS.colsMax)
  cols: number;
}

/** Mirrors `seatChangeSchema`. Omitted fields stay as they are. */
export class SeatChangeDto {
  @ApiProperty()
  @IsUUID('all')
  seatId: string;

  @ApiPropertyOptional({ enum: SEAT_TYPES })
  @OptionalNotNull()
  @IsIn(SEAT_TYPES)
  type?: SeatType;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Seat id to pair with as a couple seat, or null to leave the current pair',
  })
  @IsOptional()
  @IsUUID('all')
  coupleWith?: string | null;
}

/**
 * Mirrors `updateSeatsRequestSchema`. Applied all-or-nothing. A seat listed twice is a
 * business error (`422 INVALID_CHANGES`, from `planSeatChanges`), not a format one.
 */
export class UpdateSeatsDto {
  @ApiProperty({ type: [SeatChangeDto], minItems: 1, maxItems: ROOM_LIMITS.seatChangesMax })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ROOM_LIMITS.seatChangesMax)
  @ValidateNested({ each: true })
  @Type(() => SeatChangeDto)
  changes: SeatChangeDto[];
}
