import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgeRating, CATALOG_LIMITS, MovieStatus, SLUG_PATTERN } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trimNfcValue, trimValue } from '../../../common/dto/transforms';
import { IsIsoDate, OptionalNotNull } from '../../../common/dto/validators';

const AGE_RATINGS = Object.values(AgeRating);
const MOVIE_STATUSES = Object.values(MovieStatus);
const POSTER_KEY_MAX = 200;

/** Mirrors `createMovieRequestSchema` in @ticketify/shared. */
export class CreateMovieDto {
  @ApiProperty({ example: 'Mùa Hạ Cuối Cùng', maxLength: CATALOG_LIMITS.titleMax })
  @Transform(trimNfcValue)
  @IsString()
  @Length(1, CATALOG_LIMITS.titleMax)
  title: string;

  @ApiProperty({ description: 'Minutes', minimum: 1, maximum: CATALOG_LIMITS.durationMax })
  @IsInt()
  @Min(CATALOG_LIMITS.durationMin)
  @Max(CATALOG_LIMITS.durationMax)
  duration: number;

  @ApiProperty({ enum: AGE_RATINGS })
  @IsIn(AGE_RATINGS)
  ageRating: AgeRating;

  @ApiProperty({ enum: MOVIE_STATUSES })
  @IsIn(MOVIE_STATUSES)
  status: MovieStatus;

  @ApiProperty({ example: '2026-11-14', description: 'Calendar date YYYY-MM-DD' })
  @IsIsoDate()
  releaseDate: string;

  @ApiProperty({ type: [String], maxItems: CATALOG_LIMITS.genresPerMovieMax })
  @IsArray()
  @ArrayMaxSize(CATALOG_LIMITS.genresPerMovieMax)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  genreIds: string[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Key returned by POST /admin/uploads/poster, after the file was PUT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(POSTER_KEY_MAX)
  posterKey?: string | null;
}

/**
 * Mirrors `updateMovieRequestSchema`: every field optional, `null` only for `posterKey`
 * (removes the poster). The slug changes only when sent.
 */
export class UpdateMovieDto {
  @ApiPropertyOptional({ maxLength: CATALOG_LIMITS.titleMax })
  @Transform(trimNfcValue)
  @OptionalNotNull()
  @IsString()
  @Length(1, CATALOG_LIMITS.titleMax)
  title?: string;

  @ApiPropertyOptional({ pattern: SLUG_PATTERN.source, maxLength: CATALOG_LIMITS.slugMax })
  @Transform(trimValue)
  @OptionalNotNull()
  @IsString()
  @Length(1, CATALOG_LIMITS.slugMax)
  @Matches(SLUG_PATTERN)
  slug?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsInt()
  @Min(CATALOG_LIMITS.durationMin)
  @Max(CATALOG_LIMITS.durationMax)
  duration?: number;

  @ApiPropertyOptional({ enum: AGE_RATINGS })
  @OptionalNotNull()
  @IsIn(AGE_RATINGS)
  ageRating?: AgeRating;

  @ApiPropertyOptional({ enum: MOVIE_STATUSES })
  @OptionalNotNull()
  @IsIn(MOVIE_STATUSES)
  status?: MovieStatus;

  @ApiPropertyOptional({ example: '2026-11-14' })
  @OptionalNotNull()
  @IsIsoDate()
  releaseDate?: string;

  @ApiPropertyOptional({ type: [String], maxItems: CATALOG_LIMITS.genresPerMovieMax })
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(CATALOG_LIMITS.genresPerMovieMax)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  genreIds?: string[];

  @ApiPropertyOptional({ nullable: true, description: 'null removes the poster' })
  @IsOptional()
  @IsString()
  @MaxLength(POSTER_KEY_MAX)
  posterKey?: string | null;
}
