import {
  type AdminBooking,
  adminBookingsQuerySchema,
  ADMIN_REPORT_LIMITS,
  BookingStatus,
  formatVnd,
  PaymentStatus,
} from '@ticketify/shared';
import { Search, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AdminShell } from '@/components/admin/admin-shell';
import { Pagination } from '@/components/catalog/pagination';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  type AdminBookingsParams,
  useAdminBookings,
} from '@/features/admin-reports/admin-reports-api';
import { cinemaDate, cinemaTime } from '@/lib/cinema-time';
import { cn } from '@/lib/utils';

const vnd = (amount: number) => `${formatVnd(amount)} ₫`;
const at = (iso: string) => `${cinemaTime(iso)} ${cinemaDate(iso).split('-').reverse().join('/')}`;

const STATUS: Record<BookingStatus, { label: string; className: string }> = {
  [BookingStatus.PENDING]: {
    label: 'Chờ thanh toán',
    className: 'border-white/20 bg-white/5 text-cream',
  },
  [BookingStatus.CONFIRMED]: {
    label: 'Đã xác nhận',
    className: 'border-brand/50 bg-brand/10 text-brand',
  },
  [BookingStatus.NEEDS_REVIEW]: {
    label: 'Cần xử lý',
    className: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
  },
  [BookingStatus.EXPIRED]: {
    label: 'Hết hạn',
    className: 'border-white/15 bg-white/5 text-muted-foreground',
  },
};

const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  [PaymentStatus.PENDING]: 'Đang chờ VNPay',
  [PaymentStatus.SUCCESS]: 'Đã thanh toán',
  [PaymentStatus.FAILED]: 'Thanh toán lỗi',
  [PaymentStatus.EXPIRED]: 'Lần thanh toán hết hạn',
  [PaymentStatus.REFUND_REQUIRED]: 'Trả hai lần, cần hoàn',
};

const BOOKING_STATUSES = Object.values(BookingStatus);
const isBookingStatus = (value: string | null): value is BookingStatus =>
  BOOKING_STATUSES.includes(value as BookingStatus);

/** The filters in the URL, so a filtered list can be reloaded, bookmarked and sent to someone. */
function paramsOf(search: URLSearchParams): AdminBookingsParams {
  const status = search.get('status');
  const page = Number(search.get('page') ?? '1');
  return {
    ...(isBookingStatus(status) ? { status } : {}),
    ...(search.get('q') ? { q: search.get('q') ?? undefined } : {}),
    ...(search.get('from') ? { from: search.get('from') ?? undefined } : {}),
    ...(search.get('to') ? { to: search.get('to') ?? undefined } : {}),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function BookingRow({ booking }: { booking: AdminBooking }) {
  const status = STATUS[booking.status];
  return (
    <tr data-booking={booking.code} className="align-top">
      <td className="px-4 py-3">
        <span className="font-semibold tracking-wide text-cream">{booking.code}</span>
        <span className="block text-xs text-muted-foreground">Tạo {at(booking.createdAt)}</span>
      </td>
      <td className="px-4 py-3">
        <span className="block text-cream">{booking.user.fullName}</span>
        <span className="block text-xs break-all text-muted-foreground">{booking.user.email}</span>
      </td>
      <td className="px-4 py-3">
        <span className="block text-cream">{booking.showtime.movieTitle}</span>
        <span className="block text-xs text-muted-foreground">
          {at(booking.showtime.startsAt)} · {booking.showtime.roomName} ·{' '}
          {booking.seatLabels.join(', ')}
        </span>
      </td>
      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
            status.className,
          )}
        >
          {status.label}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {booking.paymentStatus ? PAYMENT_LABELS[booking.paymentStatus] : 'Chưa thanh toán'}
        </span>
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
        <span className="block font-semibold text-cream">{vnd(booking.total)}</span>
        {booking.voucherCode && (
          <span className="block text-xs text-muted-foreground">
            {booking.voucherCode} −{vnd(booking.discount)}
          </span>
        )}
      </td>
    </tr>
  );
}

/** `/admin/bookings` (ROADMAP 5.5): every booking, newest first, with filters kept in the URL. */
export function AdminBookingsPage() {
  const [search, setSearch] = useSearchParams();
  const params = paramsOf(search);
  const { data, isPending, error, refetch, isFetching } = useAdminBookings(params);
  const [draft, setDraft] = useState({
    q: params.q ?? '',
    status: params.status ?? '',
    from: params.from ?? '',
    to: params.to ?? '',
  });
  const [formError, setFormError] = useState<string | null>(null);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const filters = Object.fromEntries(
      Object.entries(draft)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value !== ''),
    );
    const parsed = adminBookingsQuerySchema.safeParse(filters);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Bộ lọc không hợp lệ');
      return;
    }
    setFormError(null);
    setSearch(filters);
  };

  const clear = () => {
    setDraft({ q: '', status: '', from: '', to: '' });
    setFormError(null);
    setSearch({});
  };

  const setPage = (page: number) => {
    const next = new URLSearchParams(search);
    next.set('page', String(page));
    setSearch(next);
  };

  const filtered = Boolean(params.status || params.q || params.from || params.to);

  return (
    <AdminShell title="Đơn hàng" description="Mọi đơn đặt vé, mới nhất trước.">
      <form
        onSubmit={apply}
        role="search"
        aria-label="Lọc đơn"
        className="mb-6 grid gap-3 rounded-2xl border border-white/10 bg-surface p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]"
      >
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-cream">Mã đơn hoặc email</span>
          <Input
            value={draft.q}
            maxLength={ADMIN_REPORT_LIMITS.searchMax}
            placeholder="VD: K7PX3MQ9TA hoặc @gmail"
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-cream">Trạng thái</span>
          <Select
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value })}
          >
            <option value="">Tất cả</option>
            {BOOKING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS[status].label}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-cream">Tạo từ ngày</span>
          <Input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-cream">Đến ngày</span>
          <Input
            type="date"
            value={draft.to}
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? 'booking-filter-error' : undefined}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" className="h-11 rounded-xl">
            <Search aria-hidden />
            Lọc
          </Button>
          {filtered && (
            <Button type="button" variant="ghost" className="h-11 rounded-xl" onClick={clear}>
              <X aria-hidden />
              Bỏ lọc
            </Button>
          )}
        </div>
        {formError && (
          <p
            id="booking-filter-error"
            role="alert"
            className="text-sm text-destructive sm:col-span-full"
          >
            {formError}
          </p>
        )}
      </form>

      {isPending ? (
        <div
          role="status"
          aria-label="Đang tải"
          className="h-64 animate-pulse rounded-2xl bg-white/5"
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState title={filtered ? 'Không có đơn nào khớp bộ lọc' : 'Chưa có đơn nào'} />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
            {data.total} đơn{isFetching ? ' · đang tải…' : ''}
          </p>
          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
            <table className="w-full min-w-[900px] text-left text-sm">
              <caption className="sr-only">Danh sách đơn đặt vé</caption>
              <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Đơn
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Khách hàng
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Suất chiếu &amp; ghế
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Trạng thái
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Số tiền
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.items.map((booking) => (
                  <BookingRow key={booking.id} booking={booking} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-6">
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={setPage}
            />
          </div>
        </>
      )}
    </AdminShell>
  );
}
