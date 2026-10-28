import type { ReactNode } from 'react';
import { LogoMark } from '@/components/brand/logo';

/** Centered surface card used by the login and register pages. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <section className="relative isolate px-4 py-14 sm:py-20">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(46_92_52/0.45),transparent)] blur-2xl" />
      </div>
      <div className="mx-auto w-full max-w-md rounded-3xl border border-white/10 bg-surface p-6 shadow-2xl sm:p-8">
        <div className="mb-7 space-y-2 text-center">
          <LogoMark className="mx-auto size-10 text-brand" />
          <h1 className="text-2xl font-bold text-cream">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
        <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>
      </div>
    </section>
  );
}

/** Form-level error banner (API errors), announced to screen readers. */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
