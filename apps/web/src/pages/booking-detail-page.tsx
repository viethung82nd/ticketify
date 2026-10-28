import { type Booking, BookingStatus, formatVnd } from '@ticketify/shared';
import { AlertTriangle, CircleCheck, Clock, Info, TimerOff } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { BookingStepper } from '@/components/booking/booking-stepper';
import { Button } from '@/components/ui/button';
import { useBooking } from '@/features/bookings/bookings-api';
import { formatCountdown, useCountdown } from '@/features/bookings/use-countdown';
import { errorCodeOf } from '@/features/catalog/catalog-errors';
import { SEAT_TYPE_NAMES } from '@/features/seats/seat-selection';
import { cinemaDate, cinemaTime, longDayLabel } from '@/lib/cinema-time';
import type { BookingPageState } from './booking-page';

const vnd = (amount: number) => `${formatVnd(amount)} ₫`;

const STATUS_LABELS: Record<BookingStatus, string> = {
  [BookingStatus.PENDING]: 'Chờ thanh toán',
  [BookingStatus.CONFIRMED]: 'Đã xác nhận',
  [BookingStatus.NEEDS_REVIEW]: 'Đang được xử lý',
  [BookingStatus.EXPIRED]: 'Đã hết hạn',
};

function Countdown({
  booking,
  serverOffsetMs,
  onElapsed,
}: {
  booking: Booking;
  serverOffsetMs: number;
  onElapsed: () => void;
}) {
  const remaining = useCountdown(booking.expiresAt, serverOffsetMs);
  const elapsed = remaining <= 0;
  useEffect(() => {
    if (elapsed) onElapsed();
  }, [elapsed, onElapsed]);
  if (elapsed) return null;
  const urgent = remaining < 60_000;
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-brand/40 bg-brand/10 px-5 py-4">
      <div className="flex items-center gap-3">
        <Clock className="size-6 text-brand" aria-hidden />
        <div>
          <p className="font-semibold text-cream">Ghế đang được giữ cho bạn</p>
          <p className="text-sm text-muted-foreground">
            Hoàn tất thanh toán trước khi hết giờ (hạn {cinemaTime(booking.expiresAt)}).
          </p>
        </div>
      </div>
      <p
        role="timer"
        aria-label="Thời gian giữ ghế còn lại"
        data-testid="countdown"
        data-remaining-ms={remaining}
        className={
          urgent
            ? 'text-3xl font-extrabold text-destructive tabular-nums'
            : 'text-3xl font-extrabold text-brand tabular-nums'
        }
      >
        {formatCountdown(remaining)}
      </p>
    </div>
  );
}

function ExpiredScreen({ booking }: { booking: Booking }) {
  return (
    <div
      role="alert"
      data-testid="booking-expired"
      className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-surface px-6 py-12 text-center"
    >
      <TimerOff className="size-10 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-cream">Đơn đã hết hạn</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Thời gian giữ ghế của đơn {booking.code} đã kết thúc. Ghế sẽ được trả lại cho suất chiếu.
        </p>
      </div>
      <Button asChild className="h-11 rounded-xl px-6 font-semibold">
        <Link to={`/showtimes/${booking.showtimeId}/book`}>Chọn lại ghế</Link>
      </Button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-cream tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * `/bookings/:id` (ROADMAP 2.13): the booking and, while it is PENDING, a countdown to `expiresAt`
 * anchored to the server clock. Past it, or once the API reports `expired`, the "Đơn đã hết hạn"
 * screen replaces the clock. Any other status is shown as is, without a clock.
 */
export function BookingDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const { data, isPending, error, refetch } = useBooking(id);
  const shownTotal = (location.state as BookingPageState | null)?.localTotal;
  /** The countdown reached 0 on the server clock (the API may still say PENDING: grace period). */
  const [clockElapsed, setClockElapsed] = useState(false);
  const onElapsed = useCallback(() => {
    setClockElapsed(true);
    void refetch();
  }, [refetch]);

  if (isPending) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <div
          role="status"
          aria-label="Đang tải đơn"
          className="h-80 animate-pulse rounded-2xl bg-white/5"
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        {errorCodeOf(error) === 'BOOKING_NOT_FOUND' ? (
          <EmptyState title="Không tìm thấy đơn">
            <p>Đơn không tồn tại hoặc không thuộc tài khoản của bạn.</p>
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={() => void refetch()} />
        )}
      </div>
    );
  }

  const { booking, serverOffsetMs } = data;
  const pending = booking.status === BookingStatus.PENDING;
  const expired =
    booking.status === BookingStatus.EXPIRED || (pending && (booking.expired || clockElapsed));
  const showClock = pending && !expired;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">Mã đơn</p>
        <h1
          className="text-3xl font-extrabold tracking-wider text-cream"
          data-testid="booking-code"
        >
          {booking.code}
        </h1>
      </header>
      <BookingStepper current={2} />

      {shownTotal !== undefined && shownTotal !== booking.total && (
        <p
          role="status"
          className="flex gap-2 rounded-xl border border-brand/40 bg-brand/10 px-4 py-2.5 text-sm text-cream"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          Tổng tiền máy chủ tính là {vnd(booking.total)}, khác với {vnd(shownTotal)} hiển thị lúc
          chọn (giá combo hoặc giá vé vừa thay đổi). Đơn dùng tổng của máy chủ.
        </p>
      )}

      {expired ? (
        <ExpiredScreen booking={booking} />
      ) : showClock ? (
        <>
          <Countdown booking={booking} serverOffsetMs={serverOffsetMs ?? 0} onElapsed={onElapsed} />
          {serverOffsetMs === null && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="size-3.5" aria-hidden />
              Thời gian có thể không chính xác.
            </p>
          )}
        </>
      ) : (
        <p
          role="status"
          className="flex items-center gap-2 rounded-2xl border border-white/10 bg-surface px-5 py-4 font-semibold text-cream"
        >
          <CircleCheck className="size-5 text-brand" aria-hidden />
          Trạng thái: {STATUS_LABELS[booking.status]}
        </p>
      )}

      <section
        aria-label="Chi tiết đơn"
        className="space-y-5 rounded-2xl border border-white/10 bg-surface p-5"
      >
        <div>
          <h2 className="text-lg font-bold text-cream">{booking.movie.title}</h2>
          <p className="text-sm text-muted-foreground">
            {cinemaTime(booking.showtime.startsAt)},{' '}
            {longDayLabel(cinemaDate(booking.showtime.startsAt))} · {booking.room.name}
          </p>
        </div>
        <dl className="space-y-2 border-t border-white/10 pt-4">
          {booking.seats.map((seat) => (
            <Row key={seat.seatId} label={`Ghế ${seat.label} · ${SEAT_TYPE_NAMES[seat.type]}`}>
              {vnd(seat.price)}
            </Row>
          ))}
          {booking.combos.map((combo) => (
            <Row key={combo.comboId} label={`${combo.name} × ${combo.quantity}`}>
              {vnd(combo.amount)}
            </Row>
          ))}
        </dl>
        <dl className="space-y-2 border-t border-white/10 pt-4">
          {booking.discount > 0 && <Row label="Giảm giá">−{vnd(booking.discount)}</Row>}
          <div className="flex justify-between text-base font-bold text-cream">
            <dt>Tổng cộng</dt>
            <dd className="text-brand tabular-nums" data-testid="booking-total">
              {vnd(booking.total)}
            </dd>
          </div>
        </dl>
        {showClock && (
          <p className="text-xs text-muted-foreground">
            Thanh toán VNPay sẽ có ở giai đoạn 3. Hiện chưa thể hủy giữ ghế: nếu bạn rời trang, ghế
            vẫn được giữ đến khi hết hạn.
          </p>
        )}
      </section>
    </div>
  );
}
