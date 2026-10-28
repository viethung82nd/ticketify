import {
  type AuthSession,
  authSessionSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@ticketify/shared';
import { apiClient } from '@/lib/api-client';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from './auth-store';

async function signIn(path: '/auth/login' | '/auth/register', body: object): Promise<AuthSession> {
  const response = await apiClient.post<unknown>(path, body);
  const session = authSessionSchema.parse(response.data);
  useAuthStore.getState().setSession(session);
  return session;
}

export const login = (input: LoginRequest): Promise<AuthSession> => signIn('/auth/login', input);

export const register = (input: RegisterRequest): Promise<AuthSession> =>
  signIn('/auth/register', input);

/** Ends the session locally even if the API call fails (the server side is idempotent). */
export async function logout(): Promise<void> {
  try {
    await apiClient.post('/auth/logout');
  } catch {
    // Offline or already logged out: forgetting the token locally is what matters.
  } finally {
    useAuthStore.getState().clear();
    queryClient.clear();
  }
}
