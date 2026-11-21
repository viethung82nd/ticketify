import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Toaster } from '@/components/ui/toast';
import { useNotificationStream } from '@/features/notifications/use-notification-stream';
import { scrollBehavior } from '@/lib/motion';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/** Scrolls to `#hash` targets on in-app navigation (the router does not do it). */
function useHashScroll() {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document
      .getElementById(decodeURIComponent(hash.slice(1)))
      ?.scrollIntoView({ behavior: scrollBehavior() });
  }, [hash, pathname]);
}

const MAIN_ID = 'noi-dung-chinh';

export function AppLayout() {
  useHashScroll();
  // One socket for the signed-in user's notifications, for as long as the app is open.
  useNotificationStream();
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      {/* First stop of the Tab key: past the header and its menus to the page (ROADMAP 5.6).
          Focus is moved by hand, so the URL keeps no #hash and the router is not involved. */}
      <a
        href={`#${MAIN_ID}`}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(MAIN_ID)?.focus();
        }}
        className="sr-only z-50 rounded-xl bg-brand font-semibold text-brand-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:px-4 focus:py-2"
      >
        Bỏ qua tới nội dung chính
      </a>
      <SiteHeader />
      <main id={MAIN_ID} tabIndex={-1} className="w-full flex-1 outline-none">
        <Outlet />
      </main>
      <SiteFooter />
      <Toaster />
    </div>
  );
}
