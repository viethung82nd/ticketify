import { AlertTriangle, Film, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { catalogErrorMessage } from '@/features/catalog/catalog-errors';

/** Error panel with a retry button, for failed queries. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center"
    >
      <AlertTriangle className="size-8 text-destructive" aria-hidden />
      <p className="max-w-md text-sm text-cream">{catalogErrorMessage(error)}</p>
      <Button variant="outline" onClick={onRetry} className="rounded-xl">
        <RotateCw aria-hidden />
        Thử lại
      </Button>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/15 px-6 py-14 text-center">
      <Film className="size-8 text-white/30" aria-hidden />
      <p className="font-semibold text-cream">{title}</p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}
