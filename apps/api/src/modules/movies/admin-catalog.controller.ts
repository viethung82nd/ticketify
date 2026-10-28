import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminGenre,
  type AdminMovie,
  type Genre,
  type Page,
  type PosterUpload,
  Role,
} from '@ticketify/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import { StorageService } from '../../infra/storage/storage.service';
import { GenreDto } from './dto/genre.dto';
import { ListMoviesQueryDto } from './dto/list-movies-query.dto';
import { CreateMovieDto, UpdateMovieDto } from './dto/movie.dto';
import { PosterUploadDto } from './dto/poster-upload.dto';
import { GenresService } from './genres.service';
import { MoviesService } from './movies.service';

const uuid = new ParseUUIDPipe();

@ApiTags('admin: movies')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/movies')
export class AdminMoviesController {
  constructor(private readonly movies: MoviesService) {}

  @Get()
  @ApiOkResponse({ description: 'Every status; pageSize defaults to 20 (max 50)' })
  list(@Query() query: ListMoviesQueryDto): Promise<Page<AdminMovie>> {
    return this.movies.listAdmin(query);
  }

  @Get(':id')
  @ApiNotFoundResponse({ description: 'MOVIE_NOT_FOUND' })
  get(@Param('id', uuid) id: string): Promise<AdminMovie> {
    return this.movies.getById(id);
  }

  @Post()
  @ApiCreatedResponse({ description: 'Created; slug generated from the title (-2, -3… on clash)' })
  @ApiUnprocessableEntityResponse({ description: 'INVALID_GENRES or POSTER_NOT_UPLOADED' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_UNAVAILABLE' })
  create(@Body() dto: CreateMovieDto): Promise<AdminMovie> {
    return this.movies.create(dto);
  }

  @Patch(':id')
  @ApiOkResponse({ description: 'Updated; a replaced poster is deleted from storage' })
  @ApiNotFoundResponse({ description: 'MOVIE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'SLUG_TAKEN' })
  @ApiUnprocessableEntityResponse({ description: 'INVALID_GENRES or POSTER_NOT_UPLOADED' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_UNAVAILABLE' })
  update(@Param('id', uuid) id: string, @Body() dto: UpdateMovieDto): Promise<AdminMovie> {
    return this.movies.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted with its poster' })
  @ApiNotFoundResponse({ description: 'MOVIE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'MOVIE_HAS_SHOWTIMES: set status ENDED instead' })
  remove(@Param('id', uuid) id: string): Promise<void> {
    return this.movies.remove(id);
  }
}

@ApiTags('admin: movies')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/genres')
export class AdminGenresController {
  constructor(private readonly genres: GenresService) {}

  @Get()
  @ApiOkResponse({ description: 'Genres with the number of movies using each' })
  list(): Promise<AdminGenre[]> {
    return this.genres.listAdmin();
  }

  @Post()
  @ApiConflictResponse({ description: 'GENRE_NAME_TAKEN' })
  create(@Body() dto: GenreDto): Promise<Genre> {
    return this.genres.create(dto);
  }

  @Patch(':id')
  @ApiNotFoundResponse({ description: 'GENRE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'GENRE_NAME_TAKEN' })
  rename(@Param('id', uuid) id: string, @Body() dto: GenreDto): Promise<Genre> {
    return this.genres.rename(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: 'GENRE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'GENRE_IN_USE' })
  remove(@Param('id', uuid) id: string): Promise<void> {
    return this.genres.remove(id);
  }
}

@ApiTags('admin: movies')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/uploads')
export class AdminUploadsController {
  constructor(private readonly storage: StorageService) {}

  @Post('poster')
  @ApiCreatedResponse({
    description:
      '{ key, uploadUrl, expiresIn }: PUT the file to uploadUrl within 5 minutes with exactly ' +
      'this Content-Type and size, then send key as posterKey',
  })
  presignPoster(@Body() dto: PosterUploadDto): Promise<PosterUpload> {
    return this.storage.presignPosterUpload(dto.contentType, dto.sizeBytes);
  }
}
