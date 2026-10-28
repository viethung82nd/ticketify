import type { AdminMovie, Genre as GenreView, Movie as MovieView } from '@ticketify/shared';
import type { Genre, Prisma } from '../../generated/prisma/client';

export const MOVIE_INCLUDE = {
  genres: { include: { genre: true } },
} satisfies Prisma.MovieInclude;

export type MovieWithGenres = Prisma.MovieGetPayload<{ include: typeof MOVIE_INCLUDE }>;

/** Newest release first; title breaks ties, id keeps pages stable. */
export const MOVIE_ORDER = [
  { releaseDate: 'desc' },
  { title: 'asc' },
  { id: 'asc' },
] satisfies Prisma.MovieOrderByWithRelationInput[];

/** `date` columns come back as UTC midnight; the calendar date is the ISO prefix. */
export const formatIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** `YYYY-MM-DD` (already validated) → the `Date` Prisma writes to a `date` column. */
export const parseIsoDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export const toGenreView = (genre: Genre): GenreView => ({
  id: genre.id,
  name: genre.name,
  slug: genre.slug,
});

export function toMovieView(movie: MovieWithGenres, posterUrl: string | null): MovieView {
  return {
    id: movie.id,
    title: movie.title,
    slug: movie.slug,
    duration: movie.duration,
    ageRating: movie.ageRating,
    status: movie.status,
    releaseDate: formatIsoDate(movie.releaseDate),
    posterUrl,
    genres: movie.genres
      .map((link) => toGenreView(link.genre))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
  };
}

export function toAdminMovieView(movie: MovieWithGenres, posterUrl: string | null): AdminMovie {
  return {
    ...toMovieView(movie, posterUrl),
    posterKey: movie.posterKey,
    createdAt: movie.createdAt.toISOString(),
    updatedAt: movie.updatedAt.toISOString(),
  };
}
