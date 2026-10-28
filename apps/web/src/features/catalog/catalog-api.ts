import {
  type AdminGenre,
  adminGenreSchema,
  type AdminMovie,
  adminMovieSchema,
  type CreateMovieRequest,
  type Genre,
  type GenreRequest,
  genreSchema,
  type Movie,
  type MovieListQuery,
  movieSchema,
  type Page,
  pageSchema,
  type PosterUpload,
  type PosterUploadRequest,
  posterUploadSchema,
  type UpdateMovieRequest,
} from '@ticketify/shared';
import axios from 'axios';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

const moviePageSchema = pageSchema(movieSchema);
const adminMoviePageSchema = pageSchema(adminMovieSchema);

/** Drops empty values so the API sees only the filters actually set. */
function toParams(query: Partial<MovieListQuery>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== ''),
  );
}

// ─── Public ───

export async function listMovies(query: Partial<MovieListQuery>): Promise<Page<Movie>> {
  const res = await apiClient.get<unknown>('/movies', { params: toParams(query) });
  return moviePageSchema.parse(res.data);
}

export async function getMovie(slug: string): Promise<Movie> {
  const res = await apiClient.get<unknown>(`/movies/${encodeURIComponent(slug)}`);
  return movieSchema.parse(res.data);
}

export async function listGenres(): Promise<Genre[]> {
  const res = await apiClient.get<unknown>('/genres');
  return z.array(genreSchema).parse(res.data);
}

// ─── Admin: movies ───

export async function listAdminMovies(query: Partial<MovieListQuery>): Promise<Page<AdminMovie>> {
  const res = await apiClient.get<unknown>('/admin/movies', { params: toParams(query) });
  return adminMoviePageSchema.parse(res.data);
}

export async function getAdminMovie(id: string): Promise<AdminMovie> {
  const res = await apiClient.get<unknown>(`/admin/movies/${id}`);
  return adminMovieSchema.parse(res.data);
}

export async function createMovie(body: CreateMovieRequest): Promise<AdminMovie> {
  const res = await apiClient.post<unknown>('/admin/movies', body);
  return adminMovieSchema.parse(res.data);
}

export async function updateMovie(id: string, body: UpdateMovieRequest): Promise<AdminMovie> {
  const res = await apiClient.patch<unknown>(`/admin/movies/${id}`, body);
  return adminMovieSchema.parse(res.data);
}

export async function deleteMovie(id: string): Promise<void> {
  await apiClient.delete(`/admin/movies/${id}`);
}

// ─── Admin: genres ───

export async function listAdminGenres(): Promise<AdminGenre[]> {
  const res = await apiClient.get<unknown>('/admin/genres');
  return z.array(adminGenreSchema).parse(res.data);
}

export async function createGenre(body: GenreRequest): Promise<Genre> {
  const res = await apiClient.post<unknown>('/admin/genres', body);
  return genreSchema.parse(res.data);
}

export async function renameGenre(id: string, body: GenreRequest): Promise<Genre> {
  const res = await apiClient.patch<unknown>(`/admin/genres/${id}`, body);
  return genreSchema.parse(res.data);
}

export async function deleteGenre(id: string): Promise<void> {
  await apiClient.delete(`/admin/genres/${id}`);
}

// ─── Poster upload ───

export async function presignPoster(body: PosterUploadRequest): Promise<PosterUpload> {
  const res = await apiClient.post<unknown>('/admin/uploads/poster', body);
  return posterUploadSchema.parse(res.data);
}

/**
 * PUTs the file straight to object storage. Uses bare axios, not `apiClient`: an
 * `Authorization` header would clash with the presigned signature, and the URL is not the API.
 * `Content-Type` and the body size must equal what was signed, or storage answers 403.
 */
export async function putToStorage(
  uploadUrl: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  await axios.put(uploadUrl, file, {
    headers: { 'Content-Type': file.type },
    onUploadProgress: (event) => {
      if (event.total) onProgress(Math.round((event.loaded / event.total) * 100));
    },
  });
}
