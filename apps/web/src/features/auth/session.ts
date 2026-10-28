import { type AuthSession, authSessionSchema } from '@ticketify/shared';
import axios from 'axios';
import { env } from '@/lib/env';
import { useAuthStore } from './auth-store';

/**
 * Separate instance for `/auth/refresh`: it must not go through the `apiClient` interceptors,
 * otherwise a 401 from refresh would try to refresh again.
 */
const refreshClient = axios.create({
  baseURL: env.VITE_API_URL,
  timeout: 10_000,
  // Sends the httpOnly refresh cookie (Path=/auth, SameSite=Strict).
  withCredentials: true,
  headers: { Accept: 'application/json' },
});

let inflight: Promise<AuthSession> | null = null;

/**
 * Exchanges the refresh cookie for a new access token.
 * Concurrent callers share one request: the server rotates the token on every call and treats
 * a second use of the same token as theft, so parallel refreshes must never happen.
 */
export function refreshSession(): Promise<AuthSession> {
  inflight ??= refreshClient
    .post<unknown>('/auth/refresh')
    .then((response) => {
      const session = authSessionSchema.parse(response.data);
      useAuthStore.getState().setSession(session);
      return session;
    })
    .catch((error: unknown) => {
      // The server rejected the cookie: the session is over. Network errors keep the state.
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        useAuthStore.getState().clear();
      }
      throw error;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

let started = false;

/** Restores the session once when the app mounts (safe under StrictMode double effects). */
export function startSession(): void {
  if (started) return;
  started = true;
  const store = useAuthStore.getState();
  store.setLoading();
  refreshSession().catch(() => {
    // No cookie, expired, or API unreachable: continue as a guest.
    if (useAuthStore.getState().status === 'loading') useAuthStore.getState().clear();
  });
}
