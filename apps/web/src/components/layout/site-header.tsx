import { Role } from '@ticketify/shared';
import { LogIn, LogOut, Menu, Search, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink } from 'react-router';
import { Logo } from '@/components/brand/logo';
import { logout } from '@/features/auth/auth-api';
import { useAuthStore } from '@/features/auth/auth-store';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
}

const PUBLIC_NAV: NavItem[] = [{ to: '/movies', label: 'Phim' }];

function useNavItems(): NavItem[] {
  const role = useAuthStore((state) => state.user?.role);
  const items = [...PUBLIC_NAV];
  if (role === Role.STAFF || role === Role.ADMIN) items.push({ to: '/staff', label: 'Soát vé' });
  if (role === Role.ADMIN) items.push({ to: '/admin/movies', label: 'Quản trị' });
  return items;
}

/** "Rạp" has no page yet: shown disabled so the nav matches the design. */
function CinemasSoon() {
  return (
    <span
      aria-disabled="true"
      title="Sắp có"
      className="cursor-not-allowed rounded-full px-3 py-2 text-sm text-muted-foreground/70"
    >
      Rạp <span className="sr-only">(sắp có)</span>
    </span>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-cream',
    isActive && 'text-cream',
  );

/** Right-hand side: guest links or the signed-in user's name + logout. */
function AuthActions({ onNavigate }: { onNavigate?: () => void }) {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const [pending, setPending] = useState(false);

  if (status === 'idle' || status === 'loading') {
    return <span className="h-5 w-28 animate-pulse rounded-full bg-white/10" aria-hidden />;
  }

  if (user) {
    const handleLogout = () => {
      setPending(true);
      onNavigate?.();
      void logout().finally(() => setPending(false));
    };
    return (
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm text-cream">
          <UserRound className="size-4 shrink-0 text-brand" aria-hidden />
          <span className="truncate" title={user.email}>
            {user.fullName}
          </span>
        </span>
        <button
          type="button"
          onClick={handleLogout}
          disabled={pending}
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-cream disabled:opacity-50"
        >
          <LogOut className="size-4" aria-hidden />
          Đăng xuất
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Link
        to="/login"
        onClick={onNavigate}
        className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-cream transition-colors hover:text-brand"
      >
        <LogIn className="size-4" aria-hidden />
        Đăng nhập
      </Link>
      <Link
        to="/register"
        onClick={onNavigate}
        className="rounded-full px-3 py-2 text-sm font-semibold text-brand transition-opacity hover:opacity-80"
      >
        Đăng ký
      </Link>
    </div>
  );
}

export function SiteHeader() {
  const navItems = useNavItems();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="sticky top-0 z-40 px-4 pt-4">
      {/* Desktop: two dark pills, like the reference design. */}
      <div className="mx-auto hidden max-w-6xl gap-3 md:flex">
        <div className="flex h-14 flex-1 items-center gap-8 rounded-2xl border border-white/10 bg-black/80 px-6 backdrop-blur">
          <Link to="/" aria-label="Ticketify – trang chủ">
            <Logo />
          </Link>
          <nav aria-label="Điều hướng chính" className="flex items-center gap-2">
            {navItems.map((item) => (
              <NavLink key={item.to} to={item.to} className={navLinkClass}>
                {item.label}
              </NavLink>
            ))}
            <CinemasSoon />
          </nav>
        </div>
        <div className="flex h-14 items-center gap-3 rounded-2xl border border-white/10 bg-black/80 px-4 backdrop-blur">
          <Link
            to="/movies"
            aria-label="Tìm phim"
            className="rounded-full p-2 text-cream transition-colors hover:text-brand"
          >
            <Search className="size-5" aria-hidden />
          </Link>
          <span className="h-6 w-px bg-white/15" aria-hidden />
          <AuthActions />
        </div>
      </div>

      {/* Mobile: one pill + disclosure menu. */}
      <div className="md:hidden">
        <div className="flex h-14 items-center justify-between rounded-2xl border border-white/10 bg-black/85 px-4 backdrop-blur">
          <Link to="/" aria-label="Ticketify – trang chủ" onClick={closeMenu}>
            <Logo />
          </Link>
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'}
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-full p-2 text-cream"
          >
            {menuOpen ? (
              <X className="size-5" aria-hidden />
            ) : (
              <Menu className="size-5" aria-hidden />
            )}
          </button>
        </div>
        {menuOpen && (
          <div
            id="mobile-menu"
            className="mt-2 space-y-3 rounded-2xl border border-white/10 bg-surface p-4 shadow-xl"
          >
            <nav aria-label="Điều hướng chính" className="flex flex-col">
              {navItems.map((item) => (
                <NavLink key={item.to} to={item.to} onClick={closeMenu} className={navLinkClass}>
                  {item.label}
                </NavLink>
              ))}
              <CinemasSoon />
            </nav>
            <div className="border-t border-white/10 pt-3">
              <AuthActions onNavigate={closeMenu} />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
