import type { MovieListQuery } from '@ticketify/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import {
  getAdminMovie,
  getMovie,
  listAdminGenres,
  listAdminMovies,
  listGenres,
  listMovies,
} from './catalog-api';

/** Query keys. Mutations invalidate `catalogKeys.all` so every list refreshes. */
export const catalogKeys = {
  all: ['catalog'] as const,
  movies: (query: Partial<MovieListQuery>) => ['catalog', 'movies', query] as const,
  movie: (slug: string) => ['catalog', 'movie', slug] as const,
  genres: ['catalog', 'genres'] as const,
  adminMovies: (query: Partial<MovieListQuery>) => ['catalog', 'admin-movies', query] as const,
  adminMovie: (id: string) => ['catalog', 'admin-movie', id] as const,
  adminGenres: ['catalog', 'admin-genres'] as const,
};

/** Retry once on network/5xx errors; a 4xx (e.g. 404) will not change on retry. */
const retryUnlessClientError = (failureCount: number, error: unknown): boolean => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return failureCount < 1 && !(status !== undefined && status >= 400 && status < 500);
};

export const useMovies = (query: Partial<MovieListQuery>) =>
  useQuery({
    queryKey: catalogKeys.movies(query),
    queryFn: () => listMovies(query),
    // Keep the old page on screen while the next filter/page loads.
    placeholderData: keepPreviousData,
  });

export const useMovie = (slug: string) =>
  useQuery({
    queryKey: catalogKeys.movie(slug),
    queryFn: () => getMovie(slug),
    retry: retryUnlessClientError,
  });

export const useGenres = () =>
  useQuery({ queryKey: catalogKeys.genres, queryFn: listGenres, staleTime: 5 * 60_000 });

export const useAdminMovies = (query: Partial<MovieListQuery>) =>
  useQuery({
    queryKey: catalogKeys.adminMovies(query),
    queryFn: () => listAdminMovies(query),
    placeholderData: keepPreviousData,
  });

export const useAdminMovie = (id: string) =>
  useQuery({
    queryKey: catalogKeys.adminMovie(id),
    queryFn: () => getAdminMovie(id),
    retry: retryUnlessClientError,
  });

export const useAdminGenres = () =>
  useQuery({ queryKey: catalogKeys.adminGenres, queryFn: listAdminGenres });
