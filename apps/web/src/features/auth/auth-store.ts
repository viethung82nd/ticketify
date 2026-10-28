import type { AuthSession, CurrentUser } from '@ticketify/shared';
import { create } from 'zustand';

/**
 * - `idle`: nothing tried yet (before `startSession()`).
 * - `loading`: restoring the session from the refresh cookie.
 * - `authenticated` / `anonymous`: settled.
 */
export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  /** Kept in memory only — never persisted (localStorage is readable by any injected script). */
  accessToken: string | null;
  user: CurrentUser | null;
  setLoading: () => void;
  setSession: (session: AuthSession) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: 'idle',
  accessToken: null,
  user: null,
  setLoading: () => set({ status: 'loading' }),
  setSession: (session) =>
    set({ status: 'authenticated', accessToken: session.accessToken, user: session.user }),
  clear: () => set({ status: 'anonymous', accessToken: null, user: null }),
}));
