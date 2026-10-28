import { ApiPropertyOptional } from '@nestjs/swagger';
import { CATALOG_LIMITS, MovieStatus, SLUG_PATTERN } from '@ticketify/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { blankToUndefined } from '../../../common/dto/transforms';

const MOVIE_STATUSES = Object.values(MovieStatus);

/** Query of `GET /movies` and `GET /admin/movies`; `pageSize` defaults per endpoint. */
export class ListMoviesQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: CATALOG_LIMITS.pageSizeMax })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CATALOG_LIMITS.pageSizeMax)
  pageSize?: number;

  @ApiPropertyOptional({
    enum: MOVIE_STATUSES,
    description: 'Public list: ENDED movies are hidden unless requested explicitly',
  })
  @IsOptional()
  @IsIn(MOVIE_STATUSES)
  status?: MovieStatus;

  @ApiPropertyOptional({ description: 'Genre slug' })
  @IsOptional()
  @Matches(SLUG_PATTERN)
  genre?: string;

  @ApiPropertyOptional({ description: 'Title search, case- and accent-insensitive' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_LIMITS.searchMax)
  q?: string;
}
