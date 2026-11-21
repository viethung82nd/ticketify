import type { ReactNode } from 'react';

/**
 * Frame of a wide table that scrolls sideways on a narrow screen (ROADMAP 5.6).
 *
 * - `relative`: the table's `sr-only` texts are `position: absolute`; without a positioned
 *   ancestor inside the scroll box they escape it and widen the whole page (measured: a 390 px
 *   phone page became 721 px wide on /admin/movies).
 * - `tabIndex={0}` + `role="region"` + a label: a keyboard user can focus the box and scroll it
 *   with the arrow keys, also when the table holds no button or link (axe
 *   `scrollable-region-focusable`).
 */
export function TableScroll({
  label,
  busy,
  children,
}: {
  label: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      aria-busy={busy}
      tabIndex={0}
      className="relative overflow-x-auto rounded-2xl border border-white/10 bg-surface outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
    </div>
  );
}
