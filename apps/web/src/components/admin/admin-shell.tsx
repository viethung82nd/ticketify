import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { cn } from '@/lib/utils';

const ADMIN_NAV = [
  { to: '/admin/movies', label: 'Phim' },
  { to: '/admin/genres', label: 'Thể loại' },
];

/** Page frame for admin screens: section tabs, title, optional actions on the right. */
export function AdminShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-6xl px-4 pt-10">
      <nav aria-label="Quản trị" className="mb-6 flex gap-1">
        {ADMIN_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'rounded-xl px-3.5 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-white/10 font-semibold text-cream'
                  : 'text-muted-foreground hover:text-cream',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-cream sm:text-3xl">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
