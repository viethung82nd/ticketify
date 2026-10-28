import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/** Scrolls to `#hash` targets on in-app navigation (the router does not do it). */
function useHashScroll() {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document
      .getElementById(decodeURIComponent(hash.slice(1)))
      ?.scrollIntoView({ behavior: 'smooth' });
  }, [hash, pathname]);
}

export function AppLayout() {
  useHashScroll();
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <SiteHeader />
      <main className="w-full flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
