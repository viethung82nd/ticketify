import {
  type AdminShowtime,
  adminShowtimeSchema,
  type CreatedShowtime,
  createdShowtimeSchema,
  type CreateShowtimeRequest,
  type ShowtimeDates,
  showtimeDatesSchema,
  type ShowtimeListItem,
  showtimeListItemSchema,
  type ShowtimePreview,
  showtimePreviewSchema,
} from '@ticketify/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

// ─── Public ───

export async function listMovieShowtimes(
  movieId: string,
  date: string,
): Promise<ShowtimeListItem[]> {
  const res = await apiClient.get<unknown>('/showtimes', { params: { movieId, date } });
  return z.array(showtimeListItemSchema).parse(res.data);
}

export async function listMovieShowtimeDates(movieId: string): Promise<ShowtimeDates> {
  const res = await apiClient.get<unknown>('/showtimes/dates', { params: { movieId } });
  return showtimeDatesSchema.parse(res.data);
}

// ─── Admin ───

export async function listAdminShowtimes(date: string): Promise<AdminShowtime[]> {
  const res = await apiClient.get<unknown>('/admin/showtimes', { params: { date } });
  return z.array(adminShowtimeSchema).parse(res.data);
}

export async function previewShowtime(params: CreateShowtimeRequest): Promise<ShowtimePreview> {
  const res = await apiClient.get<unknown>('/admin/showtimes/preview', { params });
  return showtimePreviewSchema.parse(res.data);
}

export async function createShowtime(body: CreateShowtimeRequest): Promise<CreatedShowtime> {
  const res = await apiClient.post<unknown>('/admin/showtimes', body);
  return createdShowtimeSchema.parse(res.data);
}

/** Idempotent: cancelling an already cancelled showtime also succeeds. */
export async function cancelShowtime(id: string): Promise<AdminShowtime> {
  const res = await apiClient.post<unknown>(`/admin/showtimes/${id}/cancel`);
  return adminShowtimeSchema.parse(res.data);
}

// ─── Queries ───

export const showtimeKeys = {
  all: ['showtimes'] as const,
  movieDay: (movieId: string, date: string) => ['showtimes', 'movie', movieId, date] as const,
  movieDates: (movieId: string) => ['showtimes', 'movie-dates', movieId] as const,
  adminDay: (date: string) => ['showtimes', 'admin', date] as const,
  preview: (params: CreateShowtimeRequest) => ['showtimes', 'preview', params] as const,
};

/** A 4xx (validation, 404, 409, 422) will not change on retry. */
const retryUnlessClientError = (failureCount: number, error: unknown): boolean => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return failureCount < 1 && !(status !== undefined && status >= 400 && status < 500);
};

export const useMovieShowtimes = (movieId: string, date: string) =>
  useQuery({
    queryKey: showtimeKeys.movieDay(movieId, date),
    queryFn: () => listMovieShowtimes(movieId, date),
    placeholderData: keepPreviousData,
  });

export const useMovieShowtimeDates = (movieId: string) =>
  useQuery({
    queryKey: showtimeKeys.movieDates(movieId),
    queryFn: () => listMovieShowtimeDates(movieId),
  });

export const useAdminShowtimes = (date: string) =>
  useQuery({
    queryKey: showtimeKeys.adminDay(date),
    queryFn: () => listAdminShowtimes(date),
    placeholderData: keepPreviousData,
  });

/** Runs only once every field is filled in (`params` is `null` until then). */
export const useShowtimePreview = (params: CreateShowtimeRequest | null) =>
  useQuery({
    queryKey: showtimeKeys.preview(params ?? { movieId: '', roomId: '', startsAt: '' }),
    queryFn: () => previewShowtime(params!),
    enabled: params !== null,
    retry: retryUnlessClientError,
    // Other admins may add showtimes meanwhile; never trust a stale preview for long.
    staleTime: 0,
  });
