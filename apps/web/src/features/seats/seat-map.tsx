import { PublicSeatStatus, rowLabel, SeatType, type ShowtimeSeat } from '@ticketify/shared';
import { Clock, Lock } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { groupOf, isSelectable, seatAriaLabel } from './seat-selection';

/**
 * Seat looks, after the Ticketor seat map. Every state has its own colour AND its own mark or
 * border, so it never relies on colour alone.
 */
const TYPE_CLASSES: Record<SeatType, string> = {
  [SeatType.STANDARD]: 'bg-[#d9d9d1] text-[#0b0b0b]',
  [SeatType.VIP]: 'bg-[#f1ec9c] text-[#0b0b0b]',
  [SeatType.COUPLE]: 'bg-[#3d3d38] text-cream border border-white/30',
};
const TYPE_MARKS: Record<SeatType, string> = {
  [SeatType.STANDARD]: '',
  [SeatType.VIP]: 'V',
  [SeatType.COUPLE]: 'Đ',
};
const HELD_CLASSES = 'bg-[#262624] text-white/55 border border-dashed border-white/35';
const SOLD_CLASSES = 'bg-[#1a1a19] text-white/40 border border-white/10';
const OFF_CLASSES =
  'bg-[#141413] text-white/30 border border-white/10 overflow-hidden after:pointer-events-none after:absolute after:top-1/2 after:left-[-3px] after:h-[2px] after:w-[calc(100%+6px)] after:-rotate-45 after:bg-white/40';
const SELECTED_CLASSES = 'ring-[3px] ring-brand ring-offset-2 ring-offset-surface';

type Look = 'free' | 'held' | 'sold' | 'off';

const lookOf = (seat: ShowtimeSeat): Look => {
  if (seat.status === PublicSeatStatus.UNAVAILABLE || seat.price === null) return 'off';
  if (seat.status === PublicSeatStatus.HELD) return 'held';
  if (seat.status === PublicSeatStatus.SOLD) return 'sold';
  return 'free';
};

function SeatFace({ seat }: { seat: ShowtimeSeat }) {
  const look = lookOf(seat);
  if (look === 'held') return <Clock className="size-3.5" aria-hidden />;
  if (look === 'sold') return <Lock className="size-3.5" aria-hidden />;
  return <>{look === 'off' ? '' : TYPE_MARKS[seat.type]}</>;
}

const seatClasses = (seat: ShowtimeSeat): string => {
  switch (lookOf(seat)) {
    case 'held':
      return HELD_CLASSES;
    case 'sold':
      return SOLD_CLASSES;
    case 'off':
      return OFF_CLASSES;
    default:
      return TYPE_CLASSES[seat.type];
  }
};

interface SeatMapProps {
  rows: number;
  cols: number;
  seats: readonly ShowtimeSeat[];
  selected: readonly string[];
  onToggle: (seat: ShowtimeSeat) => void;
  label: string;
}

/**
 * Interactive seat grid (ROADMAP 2.12): screen on top, rows labelled on the left, couple seats
 * drawn as one joined pair.
 *
 * Keyboard: the grid is ONE tab stop (roving tabindex); arrows move between seats (gaps are
 * skipped), Home/End jump to the ends of the row, Enter or Space toggles the seat. Every seat says
 * "Hàng B, ghế 5, VIP, còn trống, chưa chọn"; seats that cannot be picked stay focusable
 * (`aria-disabled`) so their state can still be read.
 */
export function SeatMap({ rows, cols, seats, selected, onToggle, label }: SeatMapProps) {
  const rowLabels = useMemo(() => Array.from({ length: rows }, (_, i) => rowLabel(i)), [rows]);
  const byPosition = useMemo(
    () => new Map(seats.map((seat) => [`${seat.row}-${seat.number}`, seat])),
    [seats],
  );
  const seatAt = (r: number, c: number) => byPosition.get(`${rowLabels[r] ?? ''}-${c + 1}`);
  const first = useMemo(() => {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (byPosition.has(`${rowLabels[r] ?? ''}-${c + 1}`)) return { r, c };
    return { r: 0, c: 0 };
  }, [rows, cols, rowLabels, byPosition]);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const current = focus && seatAt(focus.r, focus.c) ? focus : first;
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const chosen = new Set(selected);

  /** Next seat from the current cell in direction (dr, dc), skipping gaps; stays put at an edge. */
  const step = (dr: number, dc: number) => {
    let { r, c } = current;
    for (;;) {
      r += dr;
      c += dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) return current;
      if (seatAt(r, c)) return { r, c };
    }
  };
  const edge = (toEnd: boolean) => {
    const order = Array.from({ length: cols }, (_, i) => (toEnd ? cols - 1 - i : i));
    const c = order.find((col) => seatAt(current.r, col));
    return c === undefined ? current : { r: current.r, c };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, () => { r: number; c: number }> = {
      ArrowUp: () => step(-1, 0),
      ArrowDown: () => step(1, 0),
      ArrowLeft: () => step(0, -1),
      ArrowRight: () => step(0, 1),
      Home: () => edge(false),
      End: () => edge(true),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const target = move();
    setFocus(target);
    cellRefs.current.get(`${target.r}-${target.c}`)?.focus();
  };

  return (
    <div className="mx-auto w-fit">
      <div
        aria-hidden
        className="mx-auto mb-8 flex h-8 w-4/5 items-center justify-center bg-gradient-to-b from-white/25 to-white/5 text-[11px] font-semibold tracking-[0.3em] text-cream/80 uppercase [clip-path:polygon(0_0,100%_0,90%_100%,10%_100%)]"
      >
        Màn hình
      </div>
      <div
        role="grid"
        aria-label={label}
        aria-rowcount={rows}
        aria-colcount={cols + 1}
        onKeyDown={onKeyDown}
        className="space-y-2"
      >
        {rowLabels.map((row, r) => (
          <div key={row} role="row" className="flex items-center gap-1.5">
            <span
              role="rowheader"
              className="flex w-6 items-center justify-center text-xs font-semibold text-muted-foreground"
            >
              {row}
            </span>
            {Array.from({ length: cols }, (_, c) => {
              const seat = seatAt(r, c);
              if (!seat) return <span key={c} role="gridcell" className="size-8" />;
              const group = groupOf(seats, seat);
              const partner = group.find((item) => item.id !== seat.id);
              const joinsRight = partner?.row === seat.row && partner.number === seat.number + 1;
              const joinsLeft = partner?.row === seat.row && partner.number === seat.number - 1;
              const isSelected = chosen.has(seat.id);
              const isFocus = current.r === r && current.c === c;
              return (
                <span key={seat.id} role="gridcell" className="relative">
                  <button
                    ref={(el) => {
                      if (el) cellRefs.current.set(`${r}-${c}`, el);
                      else cellRefs.current.delete(`${r}-${c}`);
                    }}
                    type="button"
                    tabIndex={isFocus ? 0 : -1}
                    aria-label={seatAriaLabel(seats, seat, isSelected)}
                    aria-pressed={isSelected}
                    aria-disabled={!isSelectable(seat) && !isSelected ? true : undefined}
                    data-seat={seat.label}
                    data-status={seat.status}
                    onFocus={() => setFocus({ r, c })}
                    onClick={() => onToggle(seat)}
                    className={cn(
                      'relative flex size-8 items-center justify-center rounded-md text-xs font-bold transition-[box-shadow,transform] outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream',
                      seatClasses(seat),
                      joinsRight && 'rounded-r-none border-r-0',
                      joinsLeft && 'rounded-l-none border-l-0',
                      isSelected && SELECTED_CLASSES,
                      isSelectable(seat) || isSelected
                        ? 'cursor-pointer hover:-translate-y-px'
                        : 'cursor-not-allowed',
                    )}
                  >
                    <SeatFace seat={seat} />
                  </button>
                  {joinsRight && (
                    <span
                      aria-hidden
                      className={cn(
                        'absolute inset-y-0 -right-1.5 z-10 w-1.5 border-y',
                        lookOf(seat) === 'free'
                          ? 'border-white/30 bg-[#3d3d38]'
                          : 'border-white/15 bg-[#1f1f1d]',
                      )}
                    />
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function LegendItem({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {swatch}
      <span>{children}</span>
    </li>
  );
}

const SWATCH = 'relative flex size-6 items-center justify-center rounded text-[11px] font-bold';

export function SeatLegend() {
  return (
    <ul
      aria-label="Chú thích sơ đồ ghế"
      className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground"
    >
      <LegendItem swatch={<span aria-hidden className={cn(SWATCH, TYPE_CLASSES.STANDARD)} />}>
        Thường
      </LegendItem>
      <LegendItem
        swatch={
          <span aria-hidden className={cn(SWATCH, TYPE_CLASSES.VIP)}>
            V
          </span>
        }
      >
        VIP
      </LegendItem>
      <LegendItem
        swatch={
          <span aria-hidden className={cn(SWATCH, TYPE_CLASSES.COUPLE)}>
            Đ
          </span>
        }
      >
        Đôi
      </LegendItem>
      <LegendItem
        swatch={
          <span aria-hidden className={cn(SWATCH, TYPE_CLASSES.STANDARD, SELECTED_CLASSES)} />
        }
      >
        Đang chọn
      </LegendItem>
      <LegendItem
        swatch={
          <span aria-hidden className={cn(SWATCH, HELD_CLASSES)}>
            <Clock className="size-3" />
          </span>
        }
      >
        Đang giữ
      </LegendItem>
      <LegendItem
        swatch={
          <span aria-hidden className={cn(SWATCH, SOLD_CLASSES)}>
            <Lock className="size-3" />
          </span>
        }
      >
        Đã bán
      </LegendItem>
      <LegendItem swatch={<span aria-hidden className={cn(SWATCH, OFF_CLASSES)} />}>
        Không bán
      </LegendItem>
    </ul>
  );
}
