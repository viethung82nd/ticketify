import { Module } from '@nestjs/common';
import {
  AdminGenresController,
  AdminMoviesController,
  AdminUploadsController,
} from './admin-catalog.controller';
import { GenresService } from './genres.service';
import { GenresController, MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';

/** Catalog: movies, genres and poster uploads (ROADMAP 1.6–1.7). */
@Module({
  controllers: [
    MoviesController,
    GenresController,
    AdminMoviesController,
    AdminGenresController,
    AdminUploadsController,
  ],
  providers: [MoviesService, GenresService],
})
export class MoviesModule {}
