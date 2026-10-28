import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Genre, Movie, Page } from '@ticketify/shared';
import { Public } from '../../common/decorators/public.decorator';
import { ListMoviesQueryDto } from './dto/list-movies-query.dto';
import { GenresService } from './genres.service';
import { MoviesService } from './movies.service';

@ApiTags('movies')
@Public()
@Controller('movies')
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  @Get()
  @ApiOkResponse({
    description:
      '{ items, total, page, pageSize }. pageSize defaults to 12 (max 50); ENDED is hidden ' +
      'unless status=ENDED; newest release first',
  })
  list(@Query() query: ListMoviesQueryDto): Promise<Page<Movie>> {
    return this.movies.listPublic(query);
  }

  @Get(':slug')
  @ApiOkResponse({ description: 'Movie with genres; posterUrl is a presigned GET (1 hour)' })
  @ApiNotFoundResponse({ description: 'MOVIE_NOT_FOUND' })
  detail(@Param('slug') slug: string): Promise<Movie> {
    return this.movies.getBySlug(slug);
  }
}

@ApiTags('movies')
@Public()
@Controller('genres')
export class GenresController {
  constructor(private readonly genres: GenresService) {}

  @Get()
  @ApiOkResponse({ description: 'Every genre, sorted by name' })
  list(): Promise<Genre[]> {
    return this.genres.list();
  }
}
