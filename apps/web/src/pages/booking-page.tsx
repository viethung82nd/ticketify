import {
  BOOKING_LIMITS,
  BookingErrorCode,
  type ComboItem,
  formatVnd,
  type ShowtimeSeat,
} from '@ticketify/shared';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, Loader2, Minus, Plus, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AgeBadge } from '@/components/catalog/movie-card';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { BookingStepper } from '@/components/booking/booking-stepper';
import { Button } from '@/components/ui/button';
import { holdErrorMessage } from '@/features/bookings/booking-errors';
import { holdBooking, pendingBookingIdOf, seatIdsOf } from '@/features/bookings/bookings-api';
import { errorCodeOf } from '@/features/catalog/catalog-errors';
import { useCombos } from '@/features/combos/combos-api';
import { SeatLegend, SeatMap } from '@/features/seats/seat-map';
import {
  dropTaken,
  isSelectable,
  SEAT_TYPE_NAMES,
  SEATS_MAX,
  takenMessage,
  toggleSeat,
} from '@/features/seats/seat-selection';
import { type LiveState, useSeatMap } from '@/features/seats/use-seat-map';
import { cinemaDate, cinemaTime, longDayLabel } from '@/lib/cinema-time';
import { cn } from '@/lib/utils';

/** Router state handed to the booking page, to compare the server total with what was shown. */
export interface BookingPageState {
  localTotal?: number;
}

interface Notice {
  text: string;
  /** Existing PENDING booking to open (BOOKING_ALREADY_PENDING). */
  bookingId?: string;
}

const vnd = (amount: number) => `${formatVnd(amount)} ₫`;

function LiveBand({ live }: { live: LiveState }) {
  if (live.phase === 'live') return null;
  const failed = live.phase === 'failed';
  const text = {
    connecting: 'Đang kết nối…',
    reconnecting: 'Đang kết nối lại…',
    syncing: 'Đang làm mới sơ đồ ghế…',
    failed: live.message ?? 'Mất kết nối.',
  }[live.phase];
  return (
    <div
      role="status"
      data-live-phase={live.phase}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm',
        failed
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-brand/40 bg-brand/10 text-cream',
      )}
    >
      {failed ? (
        <WifiOff className="size-4" aria-hidden />
      ) : (
        <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
      )}
      {text}
      {live.phase === 'reconnecting' && (
        <span className="text-muted-foreground">
          Ghế hiển thị theo trạng thái cuối cùng đã biết; chưa thể đặt vé lúc này.
        </span>
      )}
    </div>
  );
}

function QuantityStepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`Số lượng ${label}`}>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={`Bớt một ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      >
        <Minus aria-hidden />
      </Button>
      <span className="w-6 text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={`Thêm một ${label}`}
        disabled={value >= BOOKING_LIMITS.comboQuantityMax}
        onClick={() => onChange(value + 1)}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}

/**
 * `/showtimes/:id/book` (ROADMAP 2.12–2.13): realtime seat map, combos, summary and "Tiếp tục",
 * which holds the seats (`POST /bookings`) and opens the booking with its countdown.
 */
export function BookingPage() {
  const { id: showtimeId = '' } = useParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  /** Seats of the request in flight: their own `seat:held` must not read as "someone took it". */
  const submitting = useRef<Set<string> | null>(null);
  /** One Idempotency-Key per attempt: kept for a retry of the same selection, new once it changes. */
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const seatsRef = useRef<readonly ShowtimeSeat[]>([]);

  const onSeatsTaken = useCallback((seatIds: string[]) => {
    const theirs = seatIds.filter((id) => !submitting.current?.has(id));
    if (theirs.length === 0) return;
    setSelected((current) => {
      const { selected: next, dropped } = dropTaken(seatsRef.current, current, theirs);
      if (dropped.length > 0) {
        const text = takenMessage(dropped);
        setNotice({ text });
        setAnnouncement(text);
      }
      return next;
    });
  }, []);

  const { query, live, reload } = useSeatMap(showtimeId, onSeatsTaken);
  const combos = useCombos();
  const map = query.data;
  const seats = useMemo(() => map?.seats ?? [], [map]);
  useEffect(() => {
    seatsRef.current = seats;
  }, [seats]);

  const byId = useMemo(() => new Map(seats.map((seat) => [seat.id, seat])), [seats]);
  const chosenSeats = selected.flatMap((id) => byId.get(id) ?? []);
  const comboItems: ComboItem[] = (combos.data ?? [])
    .filter((combo) => (quantities[combo.id] ?? 0) > 0)
    .map((combo) => ({ comboId: combo.id, quantity: quantities[combo.id] ?? 0 }));
  const seatsTotal = chosenSeats.reduce((sum, seat) => sum + (seat.price ?? 0), 0);
  const combosTotal = (combos.data ?? []).reduce(
    (sum, combo) => sum + combo.price * (quantities[combo.id] ?? 0),
    0,
  );
  const localTotal = seatsTotal + combosTotal;

  const hold = useMutation({
    mutationFn: () => {
      const seatIds = [...selected].sort();
      const signature = JSON.stringify({ seatIds, comboItems });
      if (attempt.current?.signature !== signature) {
        attempt.current = { signature, key: crypto.randomUUID() };
      }
      submitting.current = new Set(seatIds);
      return holdBooking({ showtimeId, seatIds, comboItems }, attempt.current.key);
    },
    onSuccess: (booking) => {
      const state: BookingPageState = { localTotal };
      void navigate(`/bookings/${booking.id}`, { state });
    },
    onError: async (error) => {
      const code = errorCodeOf(error);
      if (code === BookingErrorCode.SEAT_UNAVAILABLE || code === BookingErrorCode.SEAT_LOCKED) {
        // Seats lost to someone else: drop exactly those, reload the map, name them.
        let taken = seatIdsOf(error);
        await reload();
        if (taken.length === 0) {
          // SEAT_LOCKED names no seat: whichever selected seat is no longer free after the reload.
          taken = selected.filter((id) => {
            const seat = seatsRef.current.find((item) => item.id === id);
            return !seat || !isSelectable(seat);
          });
        }
        const { selected: next, dropped } = dropTaken(seatsRef.current, selected, taken);
        setSelected(next);
        const text =
          dropped.length > 0
            ? takenMessage(dropped)
            : 'Ghế bạn chọn đang được người khác đặt cùng lúc. Vui lòng bấm “Tiếp tục” lại sau giây lát.';
        setNotice({ text });
        setAnnouncement(text);
        return;
      }
      if (code === BookingErrorCode.COMBO_NOT_AVAILABLE) {
        const refreshed = await combos.refetch();
        const onSale = new Set((refreshed.data ?? []).map((combo) => combo.id));
        setQuantities((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => onSale.has(id))),
        );
      }
      if (code === BookingErrorCode.SEAT_NOT_FOUND || code === BookingErrorCode.COUPLE_INCOMPLETE) {
        await reload();
      }
      const text = holdErrorMessage(error);
      setNotice({ text, bookingId: pendingBookingIdOf(error) });
      setAnnouncement(text);
    },
    onSettled: () => {
      submitting.current = null;
    },
  });

  const toggle = (seat: ShowtimeSeat) => {
    if (hold.isPending) return;
    const result = toggleSeat(seats, selected, seat);
    setSelected(result.selected);
    setAnnouncement(result.message);
    if (!result.refused) setNotice(null);
  };

  const setQuantity = (comboId: string, quantity: number) => {
    const lines = Object.entries(quantities).filter(([id, n]) => id !== comboId && n > 0).length;
    if (quantity > 0 && lines >= BOOKING_LIMITS.comboLinesMax) {
      setAnnouncement(`Mỗi đơn tối đa ${BOOKING_LIMITS.comboLinesMax} loại combo.`);
      return;
    }
    setQuantities((current) => ({ ...current, [comboId]: quantity }));
  };

  if (query.isPending) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div
          role="status"
          aria-label="Đang tải sơ đồ ghế"
          className="h-96 animate-pulse rounded-2xl bg-white/5"
        />
      </div>
    );
  }
  if (!map) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {errorCodeOf(query.error) === 'SHOWTIME_NOT_FOUND' ? (
          <EmptyState title="Không tìm thấy suất chiếu">
            <p>Suất chiếu không tồn tại hoặc đã bị hủy.</p>
            <Button asChild variant="outline" className="mt-4 rounded-xl">
              <Link to="/movies">Xem danh sách phim</Link>
            </Button>
          </EmptyState>
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }

  const { showtime } = map;
  const canContinue = selected.length > 0 && live.phase === 'live' && !hold.isPending;
  const blockedReason =
    selected.length === 0
      ? 'Chọn ít nhất một ghế để tiếp tục.'
      : live.phase !== 'live'
        ? 'Đang chờ kết nối lại và làm mới sơ đồ ghế.'
        : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <Link
        to={`/movies/${showtime.movie.slug}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-cream"
      >
        <ChevronLeft className="size-4" aria-hidden />
        {showtime.movie.title}
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <AgeBadge rating={showtime.movie.ageRating} />
          <h1 className="text-2xl font-extrabold text-cream sm:text-3xl">Chọn ghế</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {showtime.movie.title} · {cinemaTime(showtime.startsAt)},{' '}
          {longDayLabel(cinemaDate(showtime.startsAt))} · {showtime.room.name}
        </p>
      </header>
      <BookingStepper current={0} />
      <LiveBand live={live} />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section
          aria-label="Sơ đồ ghế"
          className="space-y-6 overflow-x-auto rounded-2xl border border-white/10 bg-surface p-5 sm:p-8"
        >
          <SeatMap
            rows={showtime.room.rows}
            cols={showtime.room.cols}
            seats={seats}
            selected={selected}
            onToggle={toggle}
            label={`Sơ đồ ghế ${showtime.room.name}`}
          />
          <SeatLegend />
          <p
            role="status"
            aria-live="polite"
            data-testid="seat-announcer"
            className="min-h-5 text-center text-sm text-cream"
          >
            {announcement}
          </p>
        </section>

        <aside
          aria-label="Tóm tắt đơn"
          className="flex h-fit flex-col gap-5 rounded-2xl border border-white/10 bg-surface p-5"
        >
          <div>
            <h2 className="flex items-baseline justify-between font-semibold text-cream">
              Ghế đã chọn
              <span className="text-sm font-normal text-muted-foreground tabular-nums">
                {selected.length}/{SEATS_MAX}
              </span>
            </h2>
            {chosenSeats.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Chưa chọn ghế nào.</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm" aria-label="Danh sách ghế đã chọn">
                {chosenSeats.map((seat) => (
                  <li key={seat.id} className="flex justify-between gap-3">
                    <span className="text-cream">
                      <span className="font-semibold">{seat.label}</span>{' '}
                      <span className="text-muted-foreground">{SEAT_TYPE_NAMES[seat.type]}</span>
                    </span>
                    <span className="tabular-nums">{vnd(seat.price ?? 0)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-white/10 pt-4">
            <h2 className="font-semibold text-cream">Đồ ăn & uống</h2>
            {combos.isPending ? (
              <p className="mt-2 text-sm text-muted-foreground">Đang tải combo…</p>
            ) : combos.error ? (
              <p className="mt-2 text-sm text-destructive">Không tải được danh sách combo.</p>
            ) : combos.data.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Hiện chưa có combo.</p>
            ) : (
              <ul className="mt-2 space-y-3" aria-label="Combo">
                {combos.data.map((combo) => (
                  <li key={combo.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <p className="truncate font-medium text-cream">{combo.name}</p>
                      <p className="text-muted-foreground tabular-nums">{vnd(combo.price)}</p>
                    </div>
                    <QuantityStepper
                      label={combo.name}
                      value={quantities[combo.id] ?? 0}
                      onChange={(next) => setQuantity(combo.id, next)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <dl className="space-y-1.5 border-t border-white/10 pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Vé</dt>
              <dd className="tabular-nums">{vnd(seatsTotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Combo</dt>
              <dd className="tabular-nums">{vnd(combosTotal)}</dd>
            </div>
            <div className="flex justify-between pt-1 text-base font-bold text-cream">
              <dt>Tổng cộng</dt>
              <dd className="text-brand tabular-nums" data-testid="local-total">
                {vnd(localTotal)}
              </dd>
            </div>
            <p className="text-xs text-muted-foreground">
              Tạm tính. Máy chủ tính lại tổng tiền khi tạo đơn.
            </p>
          </dl>

          {notice && (
            <div
              role="alert"
              className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>
                {notice.text}
                {notice.bookingId && (
                  <>
                    {' '}
                    <Link to={`/bookings/${notice.bookingId}`} className="font-semibold underline">
                      Xem đơn đang chờ
                    </Link>
                  </>
                )}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Button
              type="button"
              className="h-11 w-full rounded-xl text-base font-semibold disabled:bg-white/10 disabled:text-muted-foreground disabled:opacity-100"
              disabled={!canContinue}
              aria-describedby={blockedReason ? 'continue-hint' : undefined}
              onClick={() => hold.mutate()}
            >
              {hold.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Tiếp tục
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full rounded-xl"
              disabled={selected.length === 0 || hold.isPending}
              onClick={() => {
                setSelected([]);
                setAnnouncement('Đã bỏ chọn tất cả ghế.');
              }}
            >
              Bỏ chọn tất cả
            </Button>
            {blockedReason && (
              <p id="continue-hint" className="text-center text-xs text-muted-foreground">
                {blockedReason}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
