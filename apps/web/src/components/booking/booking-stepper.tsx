import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const BOOKING_STEPS = ['Chọn ghế', 'Đồ ăn & uống', 'Thanh toán', 'Vé'] as const;

/**
 * The 4-step booking progress bar. The current step has a yellow dot; finished steps a check,
 * so state is not conveyed by colour alone.
 */
export function BookingStepper({ current }: { current: number }) {
  return (
    <ol className="grid grid-cols-4" aria-label="Các bước đặt vé">
      {BOOKING_STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className="relative flex flex-col items-center gap-2 text-center"
          >
            {index > 0 && (
              <span
                aria-hidden
                className={cn(
                  'absolute top-[9px] right-1/2 h-px w-full',
                  done || active ? 'bg-brand/60' : 'bg-white/15',
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                'relative z-10 flex size-5 items-center justify-center rounded-full border-2',
                active && 'border-brand bg-background',
                done && 'border-brand bg-brand text-brand-foreground',
                !active && !done && 'border-white/25 bg-background',
              )}
            >
              {active && <span className="size-2 rounded-full bg-brand" />}
              {done && <Check className="size-3" strokeWidth={3} />}
            </span>
            <span
              className={cn(
                'text-xs sm:text-sm',
                active ? 'font-semibold text-cream' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
