import { type AdminShowtime, isIsoDate, ShowtimeErrorCode } from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { AdminShell } from '@/components/admin/admin-shell';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { DateChips } from '@/components/schedule/date-chips';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage, errorCodeOf } from '@/features/catalog/catalog-errors';
import {
  cancelShowtime,
  showtimeKeys,
  useAdminShowtimes,
} from '@/features/showtimes/showtimes-api';
import { apiErrorOf } from '@/lib/api-error';
import { cinemaDate, cinemaTime, cinemaToday, longDayLabel, nextDays } from '@/lib/cinema-time';
import { cn } from '@/lib/utils';

const bookingCountsSchema = z.object({ heldCount: z.number(), soldCount: z.number() });

/** Vietnamese reason a cancel was refused, with the seat counts the API sends. */
function cancelErrorMessage(error: unknown): string {
  const message = catalogErrorMessage(error);
  if (errorCodeOf(error) !== ShowtimeErrorCode.SHOWTIME_HAS_BOOKINGS) return message;
  const counts = bookingCountsSchema.safeParse(apiErrorOf(error)?.details);
  return counts.success
    ? `${message} (${counts.data.soldCount} ghế đã bán, ${counts.data.heldCount} ghế đang giữ.)`
    : message;
}

/** `HH:mm` and, when the showtime ends on another day, `+1 ngày`. */
function EndTime({ showtime }: { showtime: AdminShowtime }) {
  const nextDay = cinemaDate(showtime.endsAt) !== cinemaDate(showtime.startsAt);
  return (
    <span className="tabular-nums">
      {cinemaTime(showtime.endsAt)}
      {nextDay && <span className="ml-1 text-xs text-muted-foreground">(+1 ngày)</span>}
    </span>
  );
}

function CancelDialog({
  showtime,
  onClose,
}: {
  showtime: AdminShowtime | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => cancelShowtime(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: showtimeKeys.all });
      onClose();
    },
  });

  return (
    <AlertDialog
      open={showtime !== null}
      onOpenChange={(open) => {
        if (open) return;
        mutation.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Hủy suất chiếu?</AlertDialogTitle>
        <AlertDialogDescription>
          Suất <strong className="text-cream">{showtime?.movie.title}</strong> lúc{' '}
          <strong className="text-cream">{showtime ? cinemaTime(showtime.startsAt) : ''}</strong>{' '}
          tại {showtime?.room.name} sẽ bị hủy và không hiện với khách nữa. Chỉ hủy được suất chưa
          bắt đầu và chưa có ghế nào được giữ hoặc bán.
        </AlertDialogDescription>
        <FormAlert message={mutation.error ? cancelErrorMessage(mutation.error) : null} />
        <div className="flex justify-end gap-2 pt-2">
          <AlertDialogCancel asChild>
            <Button variant="outline" className="rounded-xl">
              Đóng
            </Button>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            className="rounded-xl"
            disabled={mutation.isPending}
            onClick={() => showtime && mutation.mutate(showtime.id)}
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Hủy suất chiếu
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function StatusBadge({ status }: { status: AdminShowtime['status'] }) {
  return (
    <span
      className={cn(
        'inline-block rounded-md px-2 py-0.5 text-xs font-medium',
        status === 'SCHEDULED' ? 'bg-brand/15 text-brand' : 'bg-white/10 text-muted-foreground',
      )}
    >
      {status === 'SCHEDULED' ? 'Đã lên lịch' : 'Đã hủy'}
    </span>
  );
}

export function AdminShowtimesPage() {
  const today = cinemaToday();
  const [params, setParams] = useSearchParams();
  const requested = params.get('date') ?? '';
  const date = isIsoDate(requested) ? requested : today;
  const { data, isPending, error, refetch, isFetching } = useAdminShowtimes(date);
  const [toCancel, setToCancel] = useState<AdminShowtime | null>(null);

  const select = (next: string) => setParams(next === today ? {} : { date: next });
  const chips = nextDays(today, 7);
  if (!chips.includes(date)) chips.unshift(date);

  return (
    <AdminShell
      title="Suất chiếu"
      description="Theo ngày, giờ Việt Nam. Giờ kết thúc đã gồm thời gian dọn phòng."
      actions={
        <Button asChild className="h-10 rounded-xl px-4 font-semibold">
          <Link to={`/admin/showtimes/new?date=${date}`}>
            <Plus aria-hidden />
            Thêm suất chiếu
          </Link>
        </Button>
      }
    >
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <DateChips
          label="Chọn ngày"
          dates={chips}
          selected={date}
          today={today}
          onSelect={select}
        />
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-cream">Ngày khác</span>
          <Input
            type="date"
            value={date}
            aria-label="Chọn ngày bất kỳ"
            onChange={(e) => isIsoDate(e.target.value) && select(e.target.value)}
            className="h-10 w-44"
          />
        </label>
      </div>

      <h2 className="mb-3 text-lg font-bold text-cream">{longDayLabel(date)}</h2>
      {isPending ? (
        <div role="status" aria-label="Đang tải" className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState title="Chưa có suất chiếu nào trong ngày này">
          <Link
            to={`/admin/showtimes/new?date=${date}`}
            className="font-semibold text-brand hover:underline"
          >
            Thêm suất chiếu
          </Link>
        </EmptyState>
      ) : (
        <div
          className="overflow-x-auto rounded-2xl border border-white/10 bg-surface"
          aria-busy={isFetching}
        >
          <table className="w-full min-w-[820px] text-left text-sm">
            <caption className="sr-only">Suất chiếu {longDayLabel(date)}</caption>
            <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Phim
                </th>
                <th scope="col" className="px-4 py-3">
                  Phòng
                </th>
                <th scope="col" className="px-4 py-3">
                  Bắt đầu
                </th>
                <th scope="col" className="px-4 py-3">
                  Kết thúc
                </th>
                <th scope="col" className="px-4 py-3">
                  Trạng thái
                </th>
                <th scope="col" className="px-4 py-3">
                  Đã bán / đang giữ
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.map((showtime) => (
                <tr
                  key={showtime.id}
                  data-showtime={showtime.id}
                  className={cn(showtime.status === 'CANCELLED' && 'text-muted-foreground')}
                >
                  <td className="px-4 py-3 font-medium text-cream">{showtime.movie.title}</td>
                  <td className="px-4 py-3">{showtime.room.name}</td>
                  <td className="px-4 py-3 font-semibold text-cream tabular-nums">
                    {cinemaTime(showtime.startsAt)}
                  </td>
                  <td className="px-4 py-3">
                    <EndTime showtime={showtime} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={showtime.status} />
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {showtime.soldCount} / {showtime.heldCount}
                    <span className="ml-1 text-xs text-muted-foreground">
                      trên {showtime.seatCount} ghế
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {showtime.status === 'SCHEDULED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-lg text-destructive hover:text-destructive"
                        aria-label={`Hủy suất ${showtime.movie.title} lúc ${cinemaTime(showtime.startsAt)}`}
                        onClick={() => setToCancel(showtime)}
                      >
                        <Ban aria-hidden />
                        Hủy
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CancelDialog showtime={toCancel} onClose={() => setToCancel(null)} />
    </AdminShell>
  );
}
