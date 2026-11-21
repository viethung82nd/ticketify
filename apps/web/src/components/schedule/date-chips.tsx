import { cn } from '@/lib/utils';
import { dayChipLabel, longDayLabel } from '@/lib/cinema-time';

/**
 * A row of day chips (`T2 · 02/11`). The selected day is brand yellow with dark text.
 * `withShowtimes`, when given, dims the days that have nothing scheduled.
 */
export function DateChips({
  dates,
  selected,
  onSelect,
  today,
  withShowtimes,
  label,
}: {
  dates: string[];
  selected: string;
  onSelect: (date: string) => void;
  today: string;
  withShowtimes?: ReadonlySet<string>;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="relative flex gap-2 overflow-x-auto pb-1">
      {dates.map((date) => {
        const { weekday, day } = dayChipLabel(date);
        const isSelected = date === selected;
        const empty = withShowtimes !== undefined && !withShowtimes.has(date);
        return (
          <button
            key={date}
            type="button"
            aria-pressed={isSelected}
            data-date={date}
            onClick={() => onSelect(date)}
            className={cn(
              'flex min-w-16 shrink-0 flex-col items-center rounded-2xl border px-3 py-2 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              isSelected
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-white/10 bg-surface text-cream hover:border-white/30',
              !isSelected && empty && 'text-muted-foreground',
            )}
          >
            <span className="text-xs font-medium">{date === today ? 'Hôm nay' : weekday}</span>
            <span className="text-base font-bold tabular-nums">{day}</span>
            {/* The name starts with the visible text (WCAG 2.5.3, axe label-content-name-mismatch),
                then spells the day out for a screen reader. */}
            <span className="sr-only">
              {`, ${longDayLabel(date)}${empty ? ', không có suất' : ''}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
