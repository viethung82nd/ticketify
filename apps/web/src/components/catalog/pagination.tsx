import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 1 … 4 5 [6] 7 8 … 20 */
function pageItems(page: number, pageCount: number): (number | 'gap')[] {
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const items: (number | 'gap')[] = [];
  for (const p of sorted) {
    const last = items.at(-1);
    if (typeof last === 'number' && p - last > 1) items.push('gap');
    items.push(p);
  }
  return items;
}

const itemClass =
  'inline-flex h-9 min-w-9 items-center justify-center rounded-xl px-2 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40';

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  return (
    <nav aria-label="Phân trang" className="flex flex-wrap items-center justify-center gap-1.5">
      <button
        type="button"
        className={cn(itemClass, 'text-cream hover:bg-white/10')}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        aria-label="Trang trước"
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      {pageItems(page, pageCount).map((item, index) =>
        item === 'gap' ? (
          <span key={`gap-${index}`} className="px-1 text-muted-foreground" aria-hidden>
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            onClick={() => onPageChange(item)}
            aria-current={item === page ? 'page' : undefined}
            aria-label={`Trang ${item}`}
            className={cn(
              itemClass,
              item === page
                ? 'bg-brand font-semibold text-brand-foreground'
                : 'text-cream hover:bg-white/10',
            )}
          >
            {item}
          </button>
        ),
      )}
      <button
        type="button"
        className={cn(itemClass, 'text-cream hover:bg-white/10')}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        aria-label="Trang sau"
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </nav>
  );
}
