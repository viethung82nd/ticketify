import { type ApiError, apiErrorSchema } from '@ticketify/shared';
import axios from 'axios';

/** The API error body carried by a failed request, if any. */
export function apiErrorOf(error: unknown): ApiError | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const parsed = apiErrorSchema.safeParse(error.response?.data);
  return parsed.success ? parsed.data : undefined;
}

/** `true` when the request never got an HTTP answer (offline, CORS, timeout). */
export function isNetworkError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response === undefined;
}
