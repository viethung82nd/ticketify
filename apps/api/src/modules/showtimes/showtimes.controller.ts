import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { ShowtimeDates, ShowtimeListItem, ShowtimeSeatMap } from '@ticketify/shared';
import { Public } from '../../common/decorators/public.decorator';
import { ListShowtimesQueryDto, MovieDatesQueryDto } from './dto/showtime.dto';
import { ScheduleService } from './schedule.service';

@ApiTags('showtimes')
@Public()
@Controller('showtimes')
export class ShowtimesController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get()
  @ApiOkResponse({
    description:
      'Upcoming SCHEDULED showtimes of the movie on that cinema-time-zone day, by start, ' +
      'with the number of seats that can be booked now',
  })
  list(@Query() query: ListShowtimesQueryDto): Promise<ShowtimeListItem[]> {
    return this.schedule.listForMovie(query.movieId, query.date);
  }

  @Get('dates')
  @ApiOkResponse({ description: 'Days (YYYY-MM-DD, cinema time zone) with upcoming showtimes' })
  dates(@Query() query: MovieDatesQueryDto): Promise<ShowtimeDates> {
    return this.schedule.datesForMovie(query.movieId);
  }

  @Get(':id/seats')
  @ApiOkResponse({
    description:
      'Room grid and every seat of the room: locked price and status (expired holds shown ' +
      'AVAILABLE); seats without a ShowtimeSeat row are UNAVAILABLE with price null',
  })
  @ApiNotFoundResponse({ description: 'SHOWTIME_NOT_FOUND (also for cancelled showtimes)' })
  seats(@Param('id', new ParseUUIDPipe()) id: string): Promise<ShowtimeSeatMap> {
    return this.schedule.seatMap(id);
  }
}
