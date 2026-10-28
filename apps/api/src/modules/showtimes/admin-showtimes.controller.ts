import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminShowtime,
  type CreatedShowtime,
  Role,
  type ShowtimePreview,
} from '@ticketify/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AdminShowtimesQueryDto,
  CreateShowtimeDto,
  PreviewShowtimeQueryDto,
} from './dto/showtime.dto';
import { ShowtimesService } from './showtimes.service';

@ApiTags('admin: showtimes')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/showtimes')
export class AdminShowtimesController {
  constructor(private readonly showtimes: ShowtimesService) {}

  @Get()
  @ApiOkResponse({
    description: 'Showtimes (any status) starting that day in the cinema time zone, by start',
  })
  list(@Query() query: AdminShowtimesQueryDto): Promise<AdminShowtime[]> {
    return this.showtimes.listByDate(query.date);
  }

  @Get('preview')
  @ApiOperation({
    summary: 'Preview a showtime before creating it',
    description:
      'Same query fields and validation as POST /admin/showtimes (movieId, roomId, startsAt as ' +
      'ISO 8601 with offset). Returns startsAt, endsAt = startsAt + duration + ' +
      'SHOWTIME_CLEANUP_MINUTES, cleanupMinutes, the day type the prices would use, and the ' +
      'non-cancelled showtimes of the room that overlap [startsAt, endsAt) right now. Nothing is ' +
      'written; advisory only, the exclusion constraint decides at creation time.',
  })
  @ApiOkResponse({ description: 'endsAt, day type and current overlaps; nothing is written' })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED (including startsAt not in the future)',
  })
  @ApiNotFoundResponse({ description: 'MOVIE_NOT_FOUND, ROOM_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({ description: 'MOVIE_ENDED' })
  preview(@Query() query: PreviewShowtimeQueryDto): Promise<ShowtimePreview> {
    return this.showtimes.preview(query);
  }

  @Post()
  @ApiCreatedResponse({ description: 'Showtime and its seats with the prices locked in' })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED (including startsAt not in the future)',
  })
  @ApiNotFoundResponse({ description: 'MOVIE_NOT_FOUND, ROOM_NOT_FOUND, PRICE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'SHOWTIME_OVERLAP (details.conflicts)' })
  @ApiUnprocessableEntityResponse({ description: 'MOVIE_ENDED' })
  create(@Body() dto: CreateShowtimeDto): Promise<CreatedShowtime> {
    return this.showtimes.create(dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Cancelled; cancelling again changes nothing (idempotent)' })
  @ApiNotFoundResponse({ description: 'SHOWTIME_NOT_FOUND' })
  @ApiConflictResponse({ description: 'SHOWTIME_STARTED, SHOWTIME_HAS_BOOKINGS' })
  cancel(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminShowtime> {
    return this.showtimes.cancel(id);
  }
}
