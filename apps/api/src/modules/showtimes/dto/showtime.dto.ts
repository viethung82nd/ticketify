import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { IsIsoDate, IsIsoInstant } from '../../../common/dto/validators';

/**
 * Mirrors `createShowtimeRequestSchema`. `startsAt` must carry its offset; "in the future" is
 * checked by the service against `ClockService` (also `400 VALIDATION_FAILED`).
 */
export class CreateShowtimeDto {
  @ApiProperty()
  @IsUUID('all')
  movieId: string;

  @ApiProperty()
  @IsUUID('all')
  roomId: string;

  @ApiProperty({ example: '2026-11-02T19:30:00+07:00', description: 'ISO 8601 with offset' })
  @IsIsoInstant()
  startsAt: string;
}

/** `GET /admin/showtimes/preview`: the same fields as a create, as query parameters. */
export class PreviewShowtimeQueryDto extends CreateShowtimeDto {}

export class AdminShowtimesQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-02',
    description: 'Day in the cinema time zone (default: today there)',
  })
  @IsOptional()
  @IsIsoDate()
  date?: string;
}

export class MovieDatesQueryDto {
  @ApiProperty()
  @IsUUID('all')
  movieId: string;
}

export class ListShowtimesQueryDto extends MovieDatesQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-02',
    description: 'Day in the cinema time zone (CINEMA_TZ), not UTC (default: today there)',
  })
  @IsOptional()
  @IsIsoDate()
  date?: string;
}
