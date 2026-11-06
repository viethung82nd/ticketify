import { type Booking, BookingStatus, formatVnd } from '@ticketify/shared';
import { Download, Ticket } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { Button } from '@/components/ui/button';
import { useMyBookings } from '@/features/bookings/bookings-api';
import { useTicketPdf } from '@/features/tickets/tickets-api';
import { cinemaDate, cinemaTime } from '@/lib/cinema-time';

const vnd = (amount: number) => `${formatVnd(amount)} ₫`;

const STATUS: Record<BookingStatus, { label: string; className: string }> = {
  [BookingStatus.PENDING]: {
    label: 'Chờ thanh toán',
    className: 'border-brand/50 bg-brand/10 text-brand',
  },
  [BookingStatus.CONFIRMED]: {
    label: 'Đã xác nhận',
    className: 'border-brand/50 bg-brand/10 text-brand',
  },
  [BookingStatus.NEEDS_REVIEW]: {
    label: 'Đang được xử lý',
    className: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
  },
  [BookingStatus.EXPIRED]: {
    label: 'Đã hết hạn',
    className: 'border-white/15 bg-white/5 text-muted-foreground',
  },
};

/** The download button of one booking; only a confirmed booking has a PDF to hand out. */
function DownloadTickets({ booking }: { booking: Booking }) {
  const pdf = useTicketPdf();
  const notReady = pdf.error !== null && pdf.isError;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        className="rounded-xl"
        disabled={pdf.isPending}
        onClick={() => pdf.mutate(booking.id)}
      >
        <Download className="size-4" aria-hidden />
        {pdf.isPending ? 'Đang lấy vé…' : 'Tải vé PDF'}
      </Button>
      {notReady && (
        <p role="status" className="max-w-56 text-right text-xs text-muted-foreground">
          Vé đang được chuẩn bị, vui lòng thử lại sau một lát.
        </p>
      )}
    </div>
  );
}

function BookingRow({ booking }: { booking: Booking }) {
  const status = STATUS[booking.status];
  const seats = booking.seats.map((seat) => seat.label).join(', ');

  return (
    <li className="rounded-2xl border border-white/10 bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/bookings/${booking.id}`}
              className="text-lg font-bold text-cream hover:text-brand"
            >
              {booking.movie.title}
            </Link>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${status.className}`}
            >
              {status.label}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {cinemaTime(booking.showtime.startsAt)} · {cinemaDate(booking.showtime.startsAt)} ·{' '}
            {booking.room.name}
          </p>
          <p className="text-sm text-muted-foreground">
            Ghế {seats} · {vnd(booking.total)} · mã đơn{' '}
            <span className="font-mono text-cream">{booking.code}</span>
          </p>
        </div>
        {booking.status === BookingStatus.CONFIRMED && <DownloadTickets booking={booking} />}
      </div>
    </li>
  );
}

/**
 * `/me/bookings` (ROADMAP 4.8): the user's own booking history, newest first, with the ticket PDF
 * one click away for every confirmed one.
 *
 * The download asks the API for a fresh presigned link each time and opens it, so nothing
 * long-lived is kept in the page and the file comes straight from storage.
 */
export function MyBookingsPage() {
  const { data, isPending, error, refetch } = useMyBookings();

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex items-center gap-3">
        <Ticket className="size-7 text-brand" aria-hidden />
        <div>
          <h1 className="text-2xl font-bold text-cream">Vé của tôi</h1>
          <p className="text-sm text-muted-foreground">
            Mọi đơn bạn đã đặt, mới nhất trước. Vé của đơn đã xác nhận tải được dưới dạng PDF.
          </p>
        </div>
      </header>

      {isPending && (
        <div
          role="status"
          aria-label="Đang tải danh sách đơn"
          className="h-64 animate-pulse rounded-2xl bg-white/5"
        />
      )}
      {!isPending && !data && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && (
        <EmptyState title="Bạn chưa có đơn nào">
          <p>Chọn một suất chiếu và đặt vé, đơn của bạn sẽ xuất hiện ở đây.</p>
          <Button asChild className="mt-3 rounded-xl">
            <Link to="/movies">Xem phim đang chiếu</Link>
          </Button>
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <ul className="space-y-3">
          {data.items.map((booking) => (
            <BookingRow key={booking.id} booking={booking} />
          ))}
        </ul>
      )}
      {data && data.total > data.items.length && (
        <p className="text-sm text-muted-foreground">
          Hiển thị {data.items.length} trong {data.total} đơn.
        </p>
      )}
    </section>
  );
}
