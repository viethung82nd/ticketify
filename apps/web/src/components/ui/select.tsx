import * as React from 'react';
import { cn } from 'cn';

/** Native `<select>` styled like `Input` (keyboard and screen-reader behaviour for free). */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'h-11 w-full min-w-0 rounded-xl border border-input bg-surface-raised px-3 text-base text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive md:text-sm [&>option]:bg-surface-raised',
        className,
      )}
      {...props}
    />
  );
}

export { Select };
