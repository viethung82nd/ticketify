import type { ShowtimeListItem } from '@ticketify/shared';
import { Armchair, Clock } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '@/components/catalog/query-states';
import { DateChips } from '@/components/schedule/date-chips';
import { Button } from '@/components/ui/button';
import { useMovieShowtimeDates, useMovieShowtimes } from '@/features/showtimes/showtimes-api';
import { cinemaTime, cinemaToday, longDayLabel, nextDays } from '@/lib/cinema-time';
import { cn } from '@/lib/utils';

/** Days offered as chips, from today. Days further out are reached via "nearest day". */
const CHIP_DAYS = 7;

/** The scheduled day closest to `selected`, preferring a later one on a tie. */
function nearestDate(dates: string[], selected: string): string | undefined {
  const later = dates.find((date) => date > selected);
  const earlier = [...dates].reverse().find((date) => date < selected);
  if (!earlier) return later;
  if (!later) return earlier;
  const distance = (date: string) =>
    Math.abs(new Date(`${date}T00:00:00Z`).getTime() - new Date(`${selected}T00:00:00Z`).getTime());
  return distance(later) <= distance(earlier) ? later : earlier;
}

function ShowtimeCard({ showtime }: { showtime: ShowtimeListItem }) {
  const soldOut = showtime.availableSeats === 0;
  return (
    <li
      data-showtime={showtime.id}
      aria-label={`${cinemaTime(showtime.startsAt)}, ${showtime.room.name}, ${
        soldOut ? 'hết chỗ' : `còn ${showtime.availableSeats} ghế`
      }`}
      className={cn(
        'rounded-2xl border p-4 transition-colors',
        soldOut
          ? 'border-white/5 bg-white/[0.03] text-muted-foreground'
          : 'border-white/10 bg-surface text-cream',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className={cn('text-2xl font-bold tabular-nums', !soldOut && 'text-brand')}>
          {cinemaTime(showtime.startsAt)}
        </span>
        <span className="text-sm text-muted-foreground tabular-nums">
          – {cinemaTime(showtime.endsAt)}
        </span>
      </div>
      <p className="mt-1 text-sm font-medium">{showtime.room.name}</p>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Armchair className="size-3.5" aria-hidden />
        {soldOut ? 'Hết chỗ' : `Còn ${showtime.availableSeats}/${showtime.totalSeats} ghế`}
      </p>
    </li>
  );
}

/** "Lịch chiếu" on the movie page: day chips and that day's showtimes (no seat picking yet). */
export function MovieSchedule({ movieId }: { movieId: string }) {
  const today = cinemaToday();
  const [selected, setSelected] = useState(today);
  const showtimes = useMovieShowtimes(movieId, selected);
  const dates = useMovieShowtimeDates(movieId);

  const scheduled = new Set(dates.data?.dates ?? []);
  const chips = nextDays(today, CHIP_DAYS);
  if (!chips.includes(selected)) chips.push(selected);

  let body;
  if (showtimes.isPending) {
    body = (
      <div role="status" aria-label="Đang tải lịch chiếu" className="grid gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-white/5" />
        ))}
      </div>
    );
  } else if (showtimes.error) {
    body = <ErrorState error={showtimes.error} onRetry={() => void showtimes.refetch()} />;
  } else if (showtimes.data.length === 0) {
    const nearest = nearestDate(dates.data?.dates ?? [], selected);
    body = (
      <div className="rounded-2xl border border-dashed border-white/15 px-6 py-10 text-center">
        <p className="font-semibold text-cream">
          Không có suất chiếu vào {longDayLabel(selected)}.
        </p>
        {nearest ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Ngày gần nhất có suất chiếu:{' '}
            <Button
              variant="link"
              className="h-auto p-0 text-sm font-semibold text-brand"
              onClick={() => setSelected(nearest)}
            >
              {longDayLabel(nearest)}
            </Button>
          </p>
        ) : (
          dates.isSuccess && (
            <p className="mt-2 text-sm text-muted-foreground">Phim chưa có lịch chiếu nào.</p>
          )
        )}
      </div>
    );
  } else {
    body = (
      <ul aria-label={`Suất chiếu ${longDayLabel(selected)}`} className="grid gap-3 sm:grid-cols-4">
        {showtimes.data.map((showtime) => (
          <ShowtimeCard key={showtime.id} showtime={showtime} />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-5">
      <DateChips
        label="Chọn ngày chiếu"
        dates={chips}
        selected={selected}
        today={today}
        withShowtimes={dates.isSuccess ? scheduled : undefined}
        onSelect={setSelected}
      />
      <div aria-busy={showtimes.isFetching} aria-live="polite">
        {body}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" aria-hidden />
        Giờ chiếu theo giờ Việt Nam (GMT+7). Chọn ghế sẽ có ở bước đặt vé.
      </p>
    </div>
  );
}
