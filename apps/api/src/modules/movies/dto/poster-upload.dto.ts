import { ApiProperty } from '@nestjs/swagger';
import { CATALOG_LIMITS, type PosterContentType, posterContentTypes } from '@ticketify/shared';
import { IsIn, IsInt, Max, Min } from 'class-validator';

/** Mirrors `posterUploadRequestSchema`. */
export class PosterUploadDto {
  @ApiProperty({ enum: posterContentTypes })
  @IsIn(posterContentTypes)
  contentType: PosterContentType;

  @ApiProperty({ minimum: 1, maximum: CATALOG_LIMITS.posterMaxBytes })
  @IsInt()
  @Min(1)
  @Max(CATALOG_LIMITS.posterMaxBytes)
  sizeBytes: number;
}
