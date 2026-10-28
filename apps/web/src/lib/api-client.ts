import { AuthErrorCode } from '@ticketify/shared';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/features/auth/auth-store';
import { refreshSession } from '@/features/auth/session';
import { apiErrorOf } from './api-error';
import { env } from './env';

interface RetriableConfig extends InternalAxiosRequestConfig {
  /** Set once a request has been replayed after a refresh, so it is never replayed twice. */
  _retried?: boolean;
}

/** Shared HTTP client for the Ticketify API. */
export const apiClient = axios.create({
  baseURL: env.VITE_API_URL,
  timeout: 10_000,
  // The refresh token travels in an httpOnly cookie scoped to /auth.
  withCredentials: true,
  headers: { Accept: 'application/json' },
});

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

/** On `401 TOKEN_EXPIRED`: refresh once, then replay the original request with the new token. */
apiClient.interceptors.response.use(undefined, async (error: unknown) => {
  if (!axios.isAxiosError(error) || !error.config) throw error;
  const config: RetriableConfig = error.config;
  const expired =
    error.response?.status === 401 && apiErrorOf(error)?.code === AuthErrorCode.TOKEN_EXPIRED;
  if (!expired || config._retried) throw error;

  config._retried = true;
  try {
    await refreshSession();
  } catch {
    // Refresh failed: the caller sees the original 401, not the refresh error.
    throw error;
  }
  // The request interceptor attaches the fresh token on replay.
  return apiClient(config);
});
