import {
  formatVnd,
  type NeedsReviewBooking,
  REVIEW_LIMITS,
  ReviewFilter,
  resolveReviewRequestSchema,
} from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';
import { Pagination } from '@/components/catalog/pagination';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import {
  reviewKeys,
  resolveReview,
  useNeedsReview,
} from '@/features/admin-review/admin-review-api';
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage } from '@/features/catalog/catalog-errors';
import { cinemaDate, cinemaTime } from '@/lib/cinema-time';
import { cn } from '@/lib/utils';

/** Why the seats could not be kept (`reason` of the `booking.needs_review` event). */
const REASON_LABELS: Record<string, string> = {
  SEAT_SOLD: 'Ghế đã bán cho đơn khác',
  SEAT_HELD_BY_OTHER: 'Ghế đang được đơn khác giữ',
  SEAT_RELEASED: 'Ghế đã được nhả trước khi tiền về',
  SHOWTIME_CANCELLED: 'Suất chiếu đã bị hủy',
  SHOWTIME_ENDED: 'Suất chiếu đã kết thúc',
  NO_SEATS: 'Đơn không có ghế nào',
};

const FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: ReviewFilter.OPEN, label: 'Chưa xử lý' },
  { value: ReviewFilter.RESOLVED, label: 'Đã xử lý' },
  { value: ReviewFilter.ALL, label: 'Tất cả' },
];

const showtimeLabel = (startsAt: string) => `${cinemaDate(startsAt)} ${cinemaTime(startsAt)}`;

function ReviewRow({ item, onResolve }: { item: NeedsReviewBooking; onResolve: () => void }) {
  return (
    <tr data-booking={item.code} className="align-top">
      <td className="px-4 py-3">
        <span className="font-medium text-cream">{item.code}</span>
        <span className="block text-xs text-muted-foreground">
          {showtimeLabel(item.showtime.startsAt)} · {item.showtime.movieTitle} ·{' '}
          {item.showtime.roomName}
        </span>
        <span className="block text-xs text-muted-foreground">
          Ghế: {item.seatLabels.join(', ') || '—'}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="text-cream">{item.user.fullName}</span>
        <span className="block text-xs text-muted-foreground">{item.user.email}</span>
        {item.user.phone && (
          <span className="block text-xs text-muted-foreground">{item.user.phone}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <Badge variant="outline" className="border-white/15 text-xs text-muted-foreground">
          {(item.reason && REASON_LABELS[item.reason]) ?? item.reason ?? 'Không rõ lý do'}
        </Badge>
      </td>
      <td className="px-4 py-3 text-right text-cream tabular-nums">
        {formatVnd(item.total)} ₫
        {item.payment && (
          <span className="block text-xs text-muted-foreground">
            Mã GD VNPay: {item.payment.vnpTransactionNo ?? '—'}
          </span>
        )}
        {item.payment && (
          <span className="block text-xs text-muted-foreground">txnRef: {item.payment.txnRef}</span>
        )}
      </td>
      <td className="px-4 py-3">
        {item.resolution ? (
          <div className="text-xs text-muted-foreground">
            <span className="flex items-center gap-1 font-medium text-brand">
              <CheckCircle2 className="size-3.5" aria-hidden />
              Đã xử lý
            </span>
            <span className="block">
              {showtimeLabel(item.resolution.at)} · {item.resolution.byName ?? 'admin đã xóa'}
            </span>
            {item.resolution.note && (
              <span className="mt-1 block whitespace-pre-wrap text-cream">
                {item.resolution.note}
              </span>
            )}
          </div>
        ) : (
          <Button size="sm" className="rounded-lg" onClick={onResolve}>
            Đã xử lý
          </Button>
        )}
      </td>
    </tr>
  );
}

/** The note is required: it is the only record of what was actually done for the customer. */
function ResolveDialog({
  item,
  onClose,
}: {
  item: NeedsReviewBooking | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const parsed = resolveReviewRequestSchema.safeParse({ note });

  const save = useMutation({
    mutationFn: (body: { bookingId: string; note: string }) =>
      resolveReview(body.bookingId, body.note),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: reviewKeys.all });
      onClose();
    },
  });

  return (
    <AlertDialog
      open={item !== null}
      onOpenChange={(open) => {
        if (open) return;
        save.reset();
        setNote('');
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Đánh dấu đã xử lý?</AlertDialogTitle>
        <AlertDialogDescription>
          Đơn <strong className="text-cream">{item?.code}</strong> của{' '}
          <strong className="text-cream">{item?.user.fullName}</strong>,{' '}
          {item ? formatVnd(item.total) : 0} ₫. Hệ thống <strong>không hoàn tiền</strong>: hãy hoàn
          tiền trên cổng merchant VNPay (mã GD {item?.payment?.vnpTransactionNo ?? '—'}) hoặc liên
          hệ khách trước, rồi ghi lại ở đây. Đơn vẫn giữ trạng thái cần xử lý; thao tác này chỉ được
          lưu vào audit log và không thể sửa lại.
        </AlertDialogDescription>
        <form
          noValidate
          aria-label="Ghi chú xử lý"
          onSubmit={(e) => {
            e.preventDefault();
            if (item && parsed.success)
              save.mutate({ bookingId: item.bookingId, note: parsed.data.note });
          }}
          className="space-y-3"
        >
          <FormField label="Ghi chú (bắt buộc)">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={REVIEW_LIMITS.noteMax}
              placeholder="Ví dụ: đã hoàn 90.000 ₫ qua cổng VNPay, mã GD 16440030, đã gọi khách lúc 10:15"
              autoFocus
            />
          </FormField>
          <FormAlert message={save.error ? catalogErrorMessage(save.error) : null} />
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline" className="rounded-xl">
                Hủy
              </Button>
            </AlertDialogCancel>
            <Button
              type="submit"
              className="rounded-xl"
              disabled={save.isPending || !parsed.success}
            >
              {save.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Lưu
            </Button>
          </div>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Bookings that were paid but could not keep their seats (ROADMAP 3.8, PLAN §5). Refunds are
 * manual; this page is the queue and the record of who handled what.
 */
export function AdminReviewPage() {
  const [filter, setFilter] = useState<ReviewFilter>(ReviewFilter.OPEN);
  const [page, setPage] = useState(1);
  const [toResolve, setToResolve] = useState<NeedsReviewBooking | null>(null);
  const { data, isPending, error, refetch } = useNeedsReview({ filter, page });

  return (
    <AdminShell
      title="Đơn cần xử lý"
      description="Đơn đã thu tiền nhưng không giữ được ghế. Hệ thống không hoàn tiền tự động: hoàn tiền trên cổng merchant VNPay hoặc liên hệ khách, rồi bấm “Đã xử lý” kèm ghi chú."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((item) => (
          <Button
            key={item.value}
            variant="ghost"
            size="sm"
            aria-pressed={filter === item.value}
            onClick={() => {
              setFilter(item.value);
              setPage(1);
            }}
            className={cn(
              'rounded-full border px-3.5',
              filter === item.value
                ? 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/20 hover:text-brand'
                : 'border-white/15 text-muted-foreground',
            )}
          >
            {item.label}
          </Button>
        ))}
        {data && (
          <span className="text-sm text-muted-foreground">
            {data.total} đơn
            {filter === ReviewFilter.OPEN && data.total > 0 && (
              <ShieldAlert className="ml-1 inline size-4 text-destructive" aria-hidden />
            )}
          </span>
        )}
      </div>

      {isPending ? (
        <div
          role="status"
          aria-label="Đang tải"
          className="h-48 animate-pulse rounded-2xl bg-white/5"
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState
          title={
            filter === ReviewFilter.OPEN
              ? 'Không có đơn nào cần xử lý'
              : 'Chưa có đơn nào trong mục này'
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
            <table className="w-full min-w-[900px] text-left text-sm">
              <caption className="sr-only">Đơn đã thu tiền nhưng mất ghế</caption>
              <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Đơn &amp; suất chiếu
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Khách hàng
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Lý do
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Số tiền
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Xử lý
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.items.map((item) => (
                  <ReviewRow
                    key={item.bookingId}
                    item={item}
                    onResolve={() => setToResolve(item)}
                  />
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
      <ResolveDialog item={toResolve} onClose={() => setToResolve(null)} />
    </AdminShell>
  );
}
