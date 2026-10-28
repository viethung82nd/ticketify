import type { Role } from '@ticketify/shared';
import { Loader2 } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuthStore } from './auth-store';

/** Router state carried to /login so the user returns where they were. */
export interface FromState {
  from?: string;
}

function SessionPending() {
  return (
    <div role="status" className="flex justify-center py-24 text-muted-foreground">
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <span className="sr-only">Đang kiểm tra phiên đăng nhập…</span>
    </div>
  );
}

/**
 * Layout route: renders its children only for a signed-in user with one of `roles`
 * (any role when omitted). Guests go to /login, other roles to /forbidden.
 */
export function RequireAuth({ roles }: { roles?: Role[] }) {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const location = useLocation();

  if (status === 'idle' || status === 'loading') return <SessionPending />;
  if (!user) {
    const state: FromState = { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to="/forbidden" replace />;
  return <Outlet />;
}

/** Layout route for /login and /register: signed-in users are sent back where they came from. */
export function GuestOnly() {
  const status = useAuthStore((state) => state.status);
  const location = useLocation();

  if (status === 'idle' || status === 'loading') return <SessionPending />;
  if (status === 'authenticated') {
    const from = (location.state as FromState | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }
  return <Outlet />;
}
