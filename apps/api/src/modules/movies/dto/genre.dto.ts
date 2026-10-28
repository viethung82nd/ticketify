import { ApiProperty } from '@nestjs/swagger';
import { CATALOG_LIMITS } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
import { trimNfcValue } from '../../../common/dto/transforms';

/** Mirrors `genreRequestSchema`. Used by create and rename. */
export class GenreDto {
  @ApiProperty({ example: 'Hành động', maxLength: CATALOG_LIMITS.genreNameMax })
  @Transform(trimNfcValue)
  @IsString()
  @Length(1, CATALOG_LIMITS.genreNameMax)
  name: string;
}
