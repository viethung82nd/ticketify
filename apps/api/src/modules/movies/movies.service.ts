import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AdminMovie,
  CATALOG_LIMITS,
  CatalogErrorCode,
  MovieStatus,
  type Movie as MovieView,
  type Page,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import type { Prisma } from '../../generated/prisma/client';
import { isPrismaError, PrismaErrorCode } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../../infra/storage/storage.service';
import type { ListMoviesQueryDto } from './dto/list-movies-query.dto';
import type { CreateMovieDto, UpdateMovieDto } from './dto/movie.dto';
import {
  MOVIE_INCLUDE,
  MOVIE_ORDER,
  type MovieWithGenres,
  parseIsoDate,
  toAdminMovieView,
  toMovieView,
} from './movie-view';
import { pageOf, resolvePaging } from './paging';
import { firstFreeSlug, SEARCH_FOLD_FROM, SEARCH_FOLD_TO, searchPattern, slugify } from './slug';

type Tx = Prisma.TransactionClient;

/** Slug for titles with no Latin letters or digits at all. */
const FALLBACK_SLUG = 'phim';

/**
 * Two creates with the same title are serialized by an advisory lock, so the retry is only for
 * races with an explicit slug set by `update` at the same moment.
 */
const SLUG_ATTEMPTS = 5;

const movieNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, CatalogErrorCode.MOVIE_NOT_FOUND, 'Movie not found');

const invalidGenres = (genreIds: string[]) =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    CatalogErrorCode.INVALID_GENRES,
    'Some genres do not exist',
    { field: 'genreIds', genreIds },
  );

const hasShowtimes = () =>
  apiException(
    HttpStatus.CONFLICT,
    CatalogErrorCode.MOVIE_HAS_SHOWTIMES,
    'Movie has showtimes and cannot be deleted; set its status to ENDED instead',
  );

const slugTaken = (slug: string) =>
  apiException(HttpStatus.CONFLICT, CatalogErrorCode.SLUG_TAKEN, 'Slug is already in use', {
    field: 'slug',
    slug,
  });

export interface ListOptions {
  defaultPageSize: number;
  /** Admin lists every status; the public list hides ENDED unless asked for it. */
  includeEnded: boolean;
}

@Injectable()
export class MoviesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ─── Reads ───

  listPublic(query: ListMoviesQueryDto): Promise<Page<MovieView>> {
    return this.list(query, {
      defaultPageSize: CATALOG_LIMITS.publicPageSizeDefault,
      includeEnded: false,
    }).then(async (page) => ({
      ...page,
      items: await Promise.all(page.items.map((movie) => this.toView(movie))),
    }));
  }

  listAdmin(query: ListMoviesQueryDto): Promise<Page<AdminMovie>> {
    return this.list(query, {
      defaultPageSize: CATALOG_LIMITS.adminPageSizeDefault,
      includeEnded: true,
    }).then(async (page) => ({
      ...page,
      items: await Promise.all(page.items.map((movie) => this.toAdminView(movie))),
    }));
  }

  async getBySlug(slug: string): Promise<MovieView> {
    const movie = await this.prisma.movie.findUnique({ where: { slug }, include: MOVIE_INCLUDE });
    if (!movie) throw movieNotFound();
    return this.toView(movie);
  }

  async getById(id: string): Promise<AdminMovie> {
    const movie = await this.prisma.movie.findUnique({ where: { id }, include: MOVIE_INCLUDE });
    if (!movie) throw movieNotFound();
    return this.toAdminView(movie);
  }

  private async list(
    query: ListMoviesQueryDto,
    options: ListOptions,
  ): Promise<Page<MovieWithGenres>> {
    const paging = resolvePaging(query, options.defaultPageSize);
    const where: Prisma.MovieWhereInput = {};

    if (query.status) where.status = query.status;
    else if (!options.includeEnded) where.status = { not: MovieStatus.ENDED };
    if (query.genre) where.genres = { some: { genre: { slug: query.genre } } };
    if (query.q) where.id = { in: await this.searchIds(query.q) };

    const [total, movies] = await this.prisma.$transaction([
      this.prisma.movie.count({ where }),
      this.prisma.movie.findMany({
        where,
        include: MOVIE_INCLUDE,
        orderBy: MOVIE_ORDER,
        skip: paging.skip,
        take: paging.pageSize,
      }),
    ]);
    return pageOf(movies, total, paging);
  }

  /**
   * Ids of movies whose title contains `q`, ignoring case and Vietnamese diacritics.
   * A sequential scan: fine for one cinema's catalog (hundreds of rows), see README.
   */
  private async searchIds(q: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM movies
      WHERE lower(translate(title, ${SEARCH_FOLD_FROM}, ${SEARCH_FOLD_TO})) LIKE ${searchPattern(q)} ESCAPE '\\'`;
    return rows.map((row) => row.id);
  }

  // ─── Writes ───

  async create(dto: CreateMovieDto): Promise<AdminMovie> {
    if (dto.posterKey) await this.storage.verifyPoster(dto.posterKey);
    const base = slugify(dto.title) || FALLBACK_SLUG;

    for (let attempt = 1; ; attempt++) {
      try {
        const movie = await this.prisma.$transaction(async (tx) => {
          await this.assertGenresExist(tx, dto.genreIds);
          const slug = await this.freeSlug(tx, base);
          return tx.movie.create({
            data: {
              title: dto.title,
              slug,
              duration: dto.duration,
              ageRating: dto.ageRating,
              status: dto.status,
              releaseDate: parseIsoDate(dto.releaseDate),
              posterKey: dto.posterKey ?? null,
              genres: { create: dto.genreIds.map((genreId) => ({ genreId })) },
            },
            include: MOVIE_INCLUDE,
          });
        });
        return await this.toAdminView(movie);
      } catch (error) {
        // The whole transaction rolled back; try again with a fresh view of taken slugs.
        if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) {
          if (attempt < SLUG_ATTEMPTS) continue;
          throw slugTaken(base);
        }
        // A genre deleted between the check and the insert.
        if (isPrismaError(error, PrismaErrorCode.foreignKeyViolation)) {
          throw invalidGenres(dto.genreIds);
        }
        throw error;
      }
    }
  }

  async update(id: string, dto: UpdateMovieDto): Promise<AdminMovie> {
    if (dto.posterKey) await this.storage.verifyPoster(dto.posterKey);

    let result: { movie: MovieWithGenres; previousPosterKey: string | null };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Row lock: concurrent poster changes see each other's key, so the right one is removed.
        const previousPosterKey = await this.lockMovie(tx, id);
        if (dto.genreIds) await this.assertGenresExist(tx, dto.genreIds);
        if (dto.slug !== undefined) await this.assertSlugFree(tx, dto.slug, id);

        const movie = await tx.movie.update({
          where: { id },
          data: {
            title: dto.title,
            slug: dto.slug,
            duration: dto.duration,
            ageRating: dto.ageRating,
            status: dto.status,
            releaseDate: dto.releaseDate === undefined ? undefined : parseIsoDate(dto.releaseDate),
            posterKey: dto.posterKey,
            genres:
              dto.genreIds === undefined
                ? undefined
                : {
                    deleteMany: {},
                    create: dto.genreIds.map((genreId) => ({ genreId })),
                  },
          },
          include: MOVIE_INCLUDE,
        });
        return { movie, previousPosterKey };
      });
    } catch (error) {
      if (dto.slug !== undefined && isPrismaError(error, PrismaErrorCode.uniqueViolation)) {
        throw slugTaken(dto.slug);
      }
      if (dto.genreIds && isPrismaError(error, PrismaErrorCode.foreignKeyViolation)) {
        throw invalidGenres(dto.genreIds);
      }
      throw error;
    }

    const { movie, previousPosterKey } = result;
    if (previousPosterKey && previousPosterKey !== movie.posterKey) {
      await this.removePosterIfUnused(previousPosterKey);
    }
    return this.toAdminView(movie);
  }

  /** Only movies without any showtime; otherwise the admin should set status ENDED. */
  async remove(id: string): Promise<void> {
    let posterKey: string | null;
    try {
      posterKey = await this.prisma.$transaction(async (tx) => {
        // FOR UPDATE blocks a concurrent showtime insert (its FK check needs a share lock).
        const key = await this.lockMovie(tx, id);
        if ((await tx.showtime.count({ where: { movieId: id } })) > 0) throw hasShowtimes();
        await tx.movie.delete({ where: { id } });
        return key;
      });
    } catch (error) {
      // showtimes.movie_id is ON DELETE RESTRICT: the database is the last line of defence.
      if (isPrismaError(error, PrismaErrorCode.foreignKeyViolation)) throw hasShowtimes();
      throw error;
    }
    if (posterKey) await this.removePosterIfUnused(posterKey);
  }

  // ─── Helpers ───

  /** Locks the movie row for the rest of the transaction; returns its poster key. */
  private async lockMovie(tx: Tx, id: string): Promise<string | null> {
    const rows = await tx.$queryRaw<{ poster_key: string | null }[]>`
      SELECT poster_key FROM movies WHERE id = ${id}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw movieNotFound();
    return row.poster_key;
  }

  private async assertGenresExist(tx: Tx, genreIds: string[]): Promise<void> {
    if (genreIds.length === 0) return;
    const found = await tx.genre.findMany({
      where: { id: { in: genreIds } },
      select: { id: true },
    });
    const existing = new Set(found.map((genre) => genre.id));
    const missing = genreIds.filter((id) => !existing.has(id));
    if (missing.length > 0) throw invalidGenres(missing);
  }

  /**
   * `base`, or the first free `base-N`. Callers creating the same base wait for each other on
   * a transaction-scoped advisory lock, so they never pick the same slug; the unique index
   * stays the final arbiter.
   */
  private async freeSlug(tx: Tx, base: string): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`movie-slug:${base}`}))`;
    const rows = await tx.movie.findMany({
      where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
      select: { slug: true },
    });
    return firstFreeSlug(base, new Set(rows.map((row) => row.slug)));
  }

  private async assertSlugFree(tx: Tx, slug: string, movieId: string): Promise<void> {
    const owner = await tx.movie.findUnique({ where: { slug }, select: { id: true } });
    if (owner && owner.id !== movieId) throw slugTaken(slug);
  }

  /** Deletes a replaced poster unless another movie still points at the same object. */
  private async removePosterIfUnused(key: string): Promise<void> {
    if ((await this.prisma.movie.count({ where: { posterKey: key } })) > 0) return;
    await this.storage.deleteQuietly(key);
  }

  private async toView(movie: MovieWithGenres): Promise<MovieView> {
    return toMovieView(movie, await this.storage.posterUrl(movie.posterKey));
  }

  private async toAdminView(movie: MovieWithGenres): Promise<AdminMovie> {
    return toAdminMovieView(movie, await this.storage.posterUrl(movie.posterKey));
  }
}
