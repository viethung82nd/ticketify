import * as React from 'react';
import { cn } from 'cn';

/** Multi-line counterpart of `Input`, same colours and focus ring. */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'min-h-32 w-full min-w-0 rounded-xl border border-input bg-surface-raised px-3.5 py-2.5 text-base leading-relaxed text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/30 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
