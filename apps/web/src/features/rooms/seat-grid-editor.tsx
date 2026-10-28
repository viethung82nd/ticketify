import {
  type AdminRoom,
  type AdminSeat,
  type CoupleViolation,
  CoupleViolationReason,
  planSeatChanges,
  ROOM_LIMITS,
  RoomErrorCode,
  seatLabel,
  SeatType,
} from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RotateCcw, Save } from 'lucide-react';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage, errorCodeOf } from '@/features/catalog/catalog-errors';
import { apiErrorOf } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { updateSeats } from './rooms-api';
import {
  applyTool,
  diffSeats,
  partnerOf,
  SEAT_TYPE_LABELS,
  SEAT_TYPE_MARKS,
  SeatTool,
  TOOL_HINTS,
  TOOL_LABELS,
  violationMessage,
} from './seat-draft';
import { roomKeys } from './use-rooms';

const violationsDetailsSchema = z.object({
  violations: z.array(
    z.object({
      code: z.enum(['INVALID_COUPLE', 'COUPLE_INCONSISTENT']),
      reason: z.enum(CoupleViolationReason),
      seatIds: z.array(z.string()),
      seats: z.array(z.string()),
    }),
  ),
});

/**
 * Seat colours follow the Ticketor seat map: Available (light grey), Reserved (dark grey),
 * Selected (yellow), Unavailable (dark, struck through). Each type also carries a letter.
 */
const TYPE_CLASSES: Record<SeatType, string> = {
  STANDARD: 'bg-[#d9d9d1] text-[#0b0b0b]',
  VIP: 'bg-brand text-brand-foreground',
  COUPLE: 'bg-[#3d3d38] text-cream',
};
const OFF_CLASSES =
  'bg-[#1c1c1a] text-white/40 after:pointer-events-none after:absolute after:top-1/2 after:left-[-3px] after:h-[2px] after:w-[calc(100%+6px)] after:-rotate-45 after:bg-white/45';

function seatAriaLabel(seat: AdminSeat, seats: readonly AdminSeat[], flags: string[]): string {
  const parts = [
    `Hàng ${seat.row}`,
    `ghế ${seat.number}`,
    SEAT_TYPE_LABELS[seat.type],
    seat.isActive ? 'đang bật' : 'đang tắt',
  ];
  const partner = partnerOf(seats, seat);
  if (partner) parts.push(`ghép đôi với ${seatLabel(partner)}`);
  return [...parts, ...flags].join(', ');
}

function Legend() {
  const swatch = 'relative flex size-6 items-center justify-center rounded text-[11px] font-bold';
  return (
    <ul
      aria-label="Chú thích"
      className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground"
    >
      {(Object.keys(SEAT_TYPE_LABELS) as SeatType[]).map((type) => (
        <li key={type} className="flex items-center gap-2">
          <span aria-hidden className={cn(swatch, TYPE_CLASSES[type])}>
            {SEAT_TYPE_MARKS[type]}
          </span>
          {SEAT_TYPE_LABELS[type]}
        </li>
      ))}
      <li className="flex items-center gap-2">
        <span aria-hidden className={cn(swatch, 'overflow-visible', OFF_CLASSES)}>
          T
        </span>
        Tắt
      </li>
      <li className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(swatch, 'bg-[#d9d9d1] ring-2 ring-brand ring-offset-2 ring-offset-surface')}
        />
        Đang chọn
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className={cn(swatch, 'bg-[#d9d9d1]')}>
          <span className="absolute -top-1 -right-1 size-2.5 rounded-full border border-background bg-sky-300" />
        </span>
        Chưa lưu
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className={cn(swatch, 'bg-[#d9d9d1] ring-2 ring-destructive')}>
          !
        </span>
        Lỗi ghế đôi
      </li>
    </ul>
  );
}

function ViolationList({
  violations,
}: {
  violations: Pick<CoupleViolation, 'reason' | 'seats'>[];
}) {
  if (violations.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="size-4" aria-hidden />
        {violations.length === 1 ? 'Có 1 lỗi ghế đôi' : `Có ${violations.length} lỗi ghế đôi`}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        {violations.map((violation, index) => (
          <li key={`${violation.reason}-${violation.seats.join('-')}-${index}`}>
            {violationMessage(violation)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Grid editor for a room's seats. Edits stay in memory until "Lưu thay đổi", which sends one
 * PATCH. `planSeatChanges` (the server's own rule check) runs on every edit for early feedback.
 */
export function SeatGridEditor({ room, locked }: { room: AdminRoom; locked: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AdminSeat[]>(room.seats);
  const [tool, setTool] = useState<SeatTool>(SeatTool.VIP);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [serverViolations, setServerViolations] = useState<CoupleViolation[] | null>(null);
  const [focus, setFocus] = useState({ row: 0, col: 0 });
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const rows = useMemo(() => [...new Set(room.seats.map((s) => s.row))].sort(), [room.seats]);
  const byPosition = useMemo(
    () => new Map(draft.map((seat) => [`${seat.row}-${seat.number}`, seat])),
    [draft],
  );
  const original = useMemo(() => new Map(room.seats.map((s) => [s.id, s])), [room.seats]);

  const changes = useMemo(() => diffSeats(room.seats, draft), [room.seats, draft]);
  const clientViolations = useMemo(() => {
    if (changes.length === 0) return [];
    const plan = planSeatChanges(room.seats, changes);
    return !plan.ok && plan.code !== 'SEAT_NOT_FOUND' ? plan.violations : [];
  }, [room.seats, changes]);
  const violations = serverViolations ?? clientViolations;
  const flagged = useMemo(() => new Set(violations.flatMap((v) => v.seatIds)), [violations]);
  const tooMany = changes.length > ROOM_LIMITS.seatChangesMax;

  const save = useMutation({
    mutationFn: () => updateSeats(room.id, { changes }),
    onSuccess: async (saved) => {
      // New data → the page remounts this editor with a fresh draft.
      queryClient.setQueryData(roomKeys.detail(room.id), saved);
      await queryClient.invalidateQueries({ queryKey: roomKeys.list });
    },
    onError: async (error) => {
      const code = errorCodeOf(error);
      if (code === RoomErrorCode.INVALID_COUPLE || code === RoomErrorCode.COUPLE_INCONSISTENT) {
        const details = violationsDetailsSchema.safeParse(apiErrorOf(error)?.details);
        if (details.success) setServerViolations(details.data.violations);
      }
      if (code === RoomErrorCode.ROOM_IN_USE) {
        await queryClient.invalidateQueries({ queryKey: roomKeys.detail(room.id) });
      }
    },
  });

  const editTo = (next: AdminSeat[], nextPending: string | null, nextMessage: string | null) => {
    setDraft(next);
    setPending(nextPending);
    setMessage(nextMessage);
    setServerViolations(null);
    save.reset();
  };

  const applyAt = (seat: AdminSeat) => {
    if (locked) return;
    const result = applyTool(draft, seat.id, tool, pending);
    editTo(result.seats, result.pending, result.message);
  };

  const discard = () => editTo(room.seats, null, 'Đã hủy mọi thay đổi chưa lưu.');

  const chooseTool = (next: SeatTool) => {
    setTool(next);
    setPending(null);
    setMessage(TOOL_HINTS[next]);
  };

  const moveFocus = (row: number, col: number) => {
    const r = Math.min(Math.max(row, 0), rows.length - 1);
    const c = Math.min(Math.max(col, 0), room.cols - 1);
    setFocus({ row: r, col: c });
    cellRefs.current.get(`${r}-${c}`)?.focus();
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [focus.row - 1, focus.col],
      ArrowDown: [focus.row + 1, focus.col],
      ArrowLeft: [focus.row, focus.col - 1],
      ArrowRight: [focus.row, focus.col + 1],
      Home: [focus.row, 0],
      End: [focus.row, room.cols - 1],
    };
    const target = moves[event.key];
    if (target) {
      event.preventDefault();
      moveFocus(...target);
    } else if (event.key === 'Escape' && pending) {
      setPending(null);
      setMessage('Đã bỏ chọn.');
    }
  };

  const saveBlocked = changes.length === 0 || clientViolations.length > 0 || tooMany || locked;

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-surface p-3">
        <div role="toolbar" aria-label="Công cụ sửa ghế" className="flex flex-wrap gap-1">
          {Object.values(SeatTool).map((item) => (
            <Button
              key={item}
              type="button"
              variant={tool === item ? 'default' : 'ghost'}
              aria-pressed={tool === item}
              disabled={locked}
              onClick={() => chooseTool(item)}
              className="h-9 rounded-lg px-3"
            >
              {TOOL_LABELS[item]}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {changes.length === 0 ? 'Không có thay đổi' : `${changes.length} ghế chưa lưu`}
          </span>
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-lg"
            disabled={changes.length === 0 || save.isPending}
            onClick={discard}
          >
            <RotateCcw aria-hidden />
            Hủy thay đổi
          </Button>
          <Button
            type="button"
            className="h-9 rounded-lg font-semibold"
            disabled={saveBlocked || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Save aria-hidden />
            )}
            Lưu thay đổi
          </Button>
        </div>
      </div>

      <p role="status" className="min-h-5 text-sm text-cream">
        {locked ? 'Chế độ sửa ghế đang tắt.' : (message ?? TOOL_HINTS[tool])}
      </p>

      {tooMany && (
        <FormAlert
          message={`Mỗi lần lưu tối đa ${ROOM_LIMITS.seatChangesMax} ghế (đang có ${changes.length}). Hãy lưu bớt trước.`}
        />
      )}
      {save.error && <FormAlert message={catalogErrorMessage(save.error)} />}
      <ViolationList violations={violations} />

      {/* Grid */}
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface p-5">
        <div className="mx-auto w-fit">
          <div
            aria-hidden
            className="mx-auto mb-6 flex h-7 w-3/4 items-center justify-center bg-white/10 text-[11px] font-semibold tracking-[0.3em] text-muted-foreground uppercase [clip-path:polygon(0_0,100%_0,92%_100%,8%_100%)]"
          >
            Màn hình
          </div>
          <div
            role="grid"
            aria-label={`Sơ đồ ghế ${room.name}`}
            aria-readonly={locked || undefined}
            aria-rowcount={rows.length + 1}
            aria-colcount={room.cols + 1}
            onKeyDown={onGridKeyDown}
            className="space-y-1.5"
          >
            <div role="row" className="flex gap-1.5">
              <span role="columnheader" className="w-6">
                <span className="sr-only">Hàng</span>
              </span>
              {Array.from({ length: room.cols }, (_, c) => (
                <span
                  key={c}
                  role="columnheader"
                  className="w-8 text-center text-xs text-muted-foreground tabular-nums"
                >
                  {c + 1}
                </span>
              ))}
            </div>
            {rows.map((row, r) => (
              <div key={row} role="row" className="flex gap-1.5">
                <span
                  role="rowheader"
                  className="flex w-6 items-center justify-center text-xs font-semibold text-muted-foreground"
                >
                  {row}
                </span>
                {Array.from({ length: room.cols }, (_, c) => {
                  const seat = byPosition.get(`${row}-${c + 1}`);
                  if (!seat) return <span key={c} role="gridcell" className="size-8" />;
                  const before = original.get(seat.id);
                  const changed =
                    before !== undefined &&
                    (before.type !== seat.type ||
                      before.isActive !== seat.isActive ||
                      (partnerOf(room.seats, before)?.id ?? null) !==
                        (partnerOf(draft, seat)?.id ?? null));
                  const partner = partnerOf(draft, seat);
                  const joinsRight =
                    partner?.row === seat.row && partner.number === seat.number + 1;
                  const joinsLeft = partner?.row === seat.row && partner.number === seat.number - 1;
                  const flags = [
                    ...(changed ? ['chưa lưu'] : []),
                    ...(flagged.has(seat.id) ? ['lỗi ghế đôi'] : []),
                    ...(pending === seat.id ? ['đang chọn'] : []),
                  ];
                  const isFocus = focus.row === r && focus.col === c;
                  return (
                    <span key={seat.id} role="gridcell" className="relative">
                      <button
                        ref={(el) => {
                          if (el) cellRefs.current.set(`${r}-${c}`, el);
                          else cellRefs.current.delete(`${r}-${c}`);
                        }}
                        type="button"
                        tabIndex={isFocus ? 0 : -1}
                        aria-label={seatAriaLabel(seat, draft, flags)}
                        aria-disabled={locked || undefined}
                        data-seat={seatLabel(seat)}
                        onFocus={() => setFocus({ row: r, col: c })}
                        onClick={() => applyAt(seat)}
                        className={cn(
                          'relative flex size-8 items-center justify-center rounded-md text-xs font-bold transition-[box-shadow,transform] outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream',
                          seat.isActive ? TYPE_CLASSES[seat.type] : OFF_CLASSES,
                          joinsRight && 'rounded-r-none',
                          joinsLeft && 'rounded-l-none',
                          pending === seat.id &&
                            'ring-2 ring-brand ring-offset-2 ring-offset-surface',
                          flagged.has(seat.id) &&
                            'ring-2 ring-destructive ring-offset-1 ring-offset-surface',
                          locked
                            ? 'cursor-not-allowed opacity-70'
                            : 'cursor-pointer hover:-translate-y-px',
                        )}
                      >
                        {SEAT_TYPE_MARKS[seat.type]}
                        {changed && (
                          <span
                            aria-hidden
                            className="absolute -top-1 -right-1 size-2.5 rounded-full border border-background bg-sky-300"
                          />
                        )}
                      </button>
                      {joinsRight && (
                        <span
                          aria-hidden
                          className={cn(
                            'absolute inset-y-0 -right-1.5 w-1.5',
                            seat.isActive ? 'bg-[#3d3d38]' : 'bg-[#1c1c1a]',
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
      </div>

      <Legend />
    </div>
  );
}
