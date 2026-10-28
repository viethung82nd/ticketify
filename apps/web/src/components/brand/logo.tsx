import { cn } from '@/lib/utils';

/** Ticketify mark: a ticket with a play notch. Original artwork (not the Figma template's logo). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-7', className)}>
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7H12a4 4 0 0 0 8 0h6.5A1.5 1.5 0 0 1 28 8.5v15a1.5 1.5 0 0 1-1.5 1.5H20a4 4 0 0 0-8 0H5.5A1.5 1.5 0 0 1 4 23.5z"
        fill="currentColor"
      />
      <path d="m13.5 12 6 4-6 4z" fill="var(--background)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2 text-lg font-bold tracking-tight', className)}>
      <LogoMark className="text-brand" />
      <span className="text-cream">Ticketify</span>
    </span>
  );
}
