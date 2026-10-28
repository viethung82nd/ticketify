import { HttpStatus, Injectable } from '@nestjs/common';
import { type AdminGenre, CatalogErrorCode, type Genre as GenreView } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { isPrismaError, PrismaErrorCode } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { GenreDto } from './dto/genre.dto';
import { toGenreView } from './movie-view';
import { slugify } from './slug';

const FALLBACK_SLUG = 'the-loai';

/**
 * Vietnamese alphabetical order (Đ after D). Done here because the database collation depends
 * on the server locale (Alpine images sort by code point, putting "Đ" after "Z").
 */
const byName = new Intl.Collator('vi', { sensitivity: 'base' });
const sortByName = <T extends { name: string }>(genres: T[]): T[] =>
  genres.sort((a, b) => byName.compare(a.name, b.name));

const genreNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, CatalogErrorCode.GENRE_NOT_FOUND, 'Genre not found');

const nameTaken = () =>
  apiException(HttpStatus.CONFLICT, CatalogErrorCode.GENRE_NAME_TAKEN, 'Genre already exists', {
    field: 'name',
  });

/**
 * Genres. The slug always follows the name (`genre=<slug>` in movie filters), and both are
 * unique, so "Hành động" and "hanh dong" count as the same genre.
 */
@Injectable()
export class GenresService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<GenreView[]> {
    const genres = await this.prisma.genre.findMany();
    return sortByName(genres.map(toGenreView));
  }

  async listAdmin(): Promise<AdminGenre[]> {
    const genres = await this.prisma.genre.findMany({
      include: { _count: { select: { movies: true } } },
    });
    return sortByName(
      genres.map((genre) => ({ ...toGenreView(genre), movieCount: genre._count.movies })),
    );
  }

  async create(dto: GenreDto): Promise<GenreView> {
    try {
      const genre = await this.prisma.genre.create({
        data: { name: dto.name, slug: slugify(dto.name) || FALLBACK_SLUG },
      });
      return toGenreView(genre);
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) throw nameTaken();
      throw error;
    }
  }

  async rename(id: string, dto: GenreDto): Promise<GenreView> {
    try {
      const genre = await this.prisma.genre.update({
        where: { id },
        data: { name: dto.name, slug: slugify(dto.name) || FALLBACK_SLUG },
      });
      return toGenreView(genre);
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) throw nameTaken();
      if (isPrismaError(error, PrismaErrorCode.recordNotFound)) throw genreNotFound();
      throw error;
    }
  }

  /** `409 GENRE_IN_USE` while any movie is tagged with it (movie_genres would cascade). */
  async remove(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Tagging a movie takes a key-share lock on the genre row (FK check), which conflicts
      // with FOR UPDATE: a concurrent tag either is counted below or fails its FK afterwards.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM genres WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw genreNotFound();
      const movieCount = await tx.movieGenre.count({ where: { genreId: id } });
      if (movieCount > 0) {
        throw apiException(
          HttpStatus.CONFLICT,
          CatalogErrorCode.GENRE_IN_USE,
          'Genre is used by movies',
          { movieCount },
        );
      }
      await tx.genre.delete({ where: { id } });
    });
  }
}
