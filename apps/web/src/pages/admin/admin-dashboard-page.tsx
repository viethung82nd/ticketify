import {
  addDays,
  ADMIN_REPORT_LIMITS,
  formatVnd,
  type RevenueDay,
  revenueQuerySchema,
  type ShowtimeOccupancy,
  ShowtimeStatus,
} from '@ticketify/shared';
import { type FormEvent, useState } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOccupancy, useRevenue } from '@/features/admin-reports/admin-reports-api';
import { cinemaTime, cinemaToday } from '@/lib/cinema-time';
import { cn } from '@/lib/utils';

const vnd = (amount: number) => `${formatVnd(amount)} ₫`;
/** `2026-11-02` → `02/11`. */
const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** Axis ticks: 0, 500K, 1,2M… — compact once the axis reaches 10 000. */
function compactVnd(amount: number): string {
  if (amount >= 1_000_000) return `${formatVnd(Math.round(amount / 100_000) / 10)}M`;
  if (amount >= 10_000) return `${formatVnd(Math.round(amount / 1_000))}K`;
  return formatVnd(amount);
}
/** A round axis maximum at or above `max`: 1, 2 or 5 × 10^n. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].find((step) => step * power >= max) ?? 10) * power;
}

function StatTile({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-surface p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold text-cream tabular-nums" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

/**
 * Revenue per day as columns (one series: no legend, the heading names it). Each column is
 * focusable and shows its day, revenue and counts on hover or focus; the same numbers are in the
 * table below, so the tooltip never gates a value.
 */
function RevenueChart({ days }: { days: RevenueDay[] }) {
  const [active, setActive] = useState<string | null>(null);
  const top = niceMax(Math.max(...days.map((day) => day.revenue)));
  const ticks = [top, top / 2, 0];
  const shown = days.find((day) => day.date === active);

  return (
    <div className="relative" onPointerLeave={() => setActive(null)}>
      <div className="flex gap-3">
        <div
          className="flex h-56 flex-col justify-between py-0 text-right text-xs text-muted-foreground tabular-nums"
          aria-hidden
        >
          {ticks.map((tick) => (
            <span key={tick} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {compactVnd(tick)}
            </span>
          ))}
        </div>
        <div className="relative h-56 flex-1">
          {ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden
              className="absolute inset-x-0 border-t border-white/10"
              style={{ bottom: `${(tick / top) * 100}%` }}
            />
          ))}
          <ol
            aria-label="Doanh thu theo ngày"
            className="absolute inset-0 flex items-end justify-around gap-0.5"
          >
            {days.map((day) => {
              const height = (day.revenue / top) * 100;
              return (
                <li
                  key={day.date}
                  tabIndex={0}
                  data-day={day.date}
                  aria-label={`${dayMonth(day.date)}: ${vnd(day.revenue)}, ${day.bookings} đơn, ${day.tickets} vé`}
                  onPointerEnter={() => setActive(day.date)}
                  onFocus={() => setActive(day.date)}
                  onBlur={() => setActive(null)}
                  className="group flex h-full flex-1 cursor-default items-end justify-center outline-none"
                >
                  <span
                    className={cn(
                      'block w-full max-w-6 rounded-t bg-brand transition-opacity',
                      active && active !== day.date && 'opacity-50',
                      'group-focus-visible:ring-2 group-focus-visible:ring-cream',
                    )}
                    style={{ height: day.revenue > 0 ? `max(${height}%, 2px)` : '0' }}
                  />
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <div className="mt-2 flex gap-3" aria-hidden>
        <div className="invisible text-xs">{compactVnd(top)}</div>
        <div className="flex flex-1 justify-around text-xs text-muted-foreground tabular-nums">
          {days.map((day, index) => (
            <span key={day.date} className="flex-1 text-center">
              {/* Every label when there is room, else every few days. */}
              {days.length <= 14 || index % Math.ceil(days.length / 10) === 0
                ? dayMonth(day.date)
                : ''}
            </span>
          ))}
        </div>
      </div>
      {shown && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 right-0 rounded-xl border border-white/10 bg-surface-raised px-3 py-2 text-sm shadow-lg"
          data-testid="revenue-tooltip"
        >
          <p className="font-semibold text-cream tabular-nums">{vnd(shown.revenue)}</p>
          <p className="text-xs text-muted-foreground">
            {dayMonth(shown.date)} · {shown.bookings} đơn · {shown.tickets} vé
          </p>
        </div>
      )}
    </div>
  );
}

function OccupancyRow({ showtime }: { showtime: ShowtimeOccupancy }) {
  const percent = Math.round(showtime.occupancy * 100);
  const cancelled = showtime.status === ShowtimeStatus.CANCELLED;
  return (
    <tr data-showtime={showtime.id} className={cn(cancelled && 'opacity-60')}>
      <td className="px-4 py-3 whitespace-nowrap text-cream tabular-nums">
        {cinemaTime(showtime.startsAt)}
      </td>
      <td className="px-4 py-3">
        <span className="text-cream">{showtime.movieTitle}</span>
        {cancelled && <span className="ml-2 text-xs text-muted-foreground">(đã hủy)</span>}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{showtime.roomName}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            role="meter"
            aria-valuemin={0}
            aria-valuemax={showtime.totalSeats}
            aria-valuenow={showtime.soldSeats}
            aria-label={`Đã bán ${showtime.soldSeats}/${showtime.totalSeats} ghế`}
            className="h-2 w-32 overflow-hidden rounded-full bg-white/10"
          >
            <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
          </div>
          <span className="w-10 text-right font-semibold text-cream tabular-nums">{percent}%</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right text-cream tabular-nums">
        {showtime.soldSeats}/{showtime.totalSeats}
      </td>
      <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
        {showtime.heldSeats}
      </td>
    </tr>
  );
}

/**
 * `/admin/dashboard` (ROADMAP 5.5): revenue per day over a range (last 7 days by default) and
 * how full each showtime of one day is (today by default, refreshed every 30 s).
 */
export function AdminDashboardPage() {
  const today = cinemaToday();
  const [range, setRange] = useState({
    from: addDays(today, -(ADMIN_REPORT_LIMITS.revenueDaysDefault - 1)),
    to: today,
  });
  const [draft, setDraft] = useState(range);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [day, setDay] = useState(today);
  const revenue = useRevenue(range.from, range.to);
  const occupancy = useOccupancy(day);

  const applyRange = (event: FormEvent) => {
    event.preventDefault();
    const parsed = revenueQuerySchema.safeParse(draft);
    if (!parsed.success) {
      setRangeError(parsed.error.issues[0]?.message ?? 'Khoảng ngày không hợp lệ');
      return;
    }
    setRangeError(null);
    setRange(draft);
  };

  return (
    <AdminShell title="Tổng quan" description="Doanh thu theo ngày và tỷ lệ lấp đầy suất chiếu.">
      <section aria-labelledby="revenue-heading" className="mb-10 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="revenue-heading" className="text-lg font-bold text-cream">
              Doanh thu theo ngày
            </h2>
            <p className="text-sm text-muted-foreground">
              Tổng tiền (sau giảm giá) của các đơn xác nhận trong ngày, theo giờ rạp. Không tính đơn
              cần xử lý.
            </p>
          </div>
          <form
            onSubmit={applyRange}
            aria-label="Khoảng ngày"
            className="flex flex-wrap items-end gap-2"
          >
            <label className="space-y-1 text-sm">
              <span className="block text-muted-foreground">Từ ngày</span>
              <Input
                type="date"
                value={draft.from}
                className="w-40"
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-muted-foreground">Đến ngày</span>
              <Input
                type="date"
                value={draft.to}
                className="w-40"
                aria-invalid={rangeError ? true : undefined}
                aria-describedby={rangeError ? 'revenue-range-error' : undefined}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </label>
            <Button type="submit" variant="outline" className="h-11 rounded-xl">
              Xem
            </Button>
            {rangeError && (
              <p id="revenue-range-error" role="alert" className="w-full text-sm text-destructive">
                {rangeError}
              </p>
            )}
          </form>
        </div>

        {revenue.isPending ? (
          <div
            role="status"
            aria-label="Đang tải doanh thu"
            className="h-72 animate-pulse rounded-2xl bg-white/5"
          />
        ) : revenue.error ? (
          <ErrorState error={revenue.error} onRetry={() => void revenue.refetch()} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="Doanh thu"
                value={vnd(revenue.data.totals.revenue)}
                testId="revenue-total"
              />
              <StatTile
                label="Đơn xác nhận"
                value={String(revenue.data.totals.bookings)}
                testId="revenue-bookings"
              />
              <StatTile
                label="Vé bán ra"
                value={String(revenue.data.totals.tickets)}
                testId="revenue-tickets"
              />
            </div>
            <div className="rounded-2xl border border-white/10 bg-surface p-5">
              <RevenueChart days={revenue.data.days} />
            </div>
            <details className="rounded-2xl border border-white/10 bg-surface px-5 py-3 text-sm">
              <summary className="cursor-pointer text-cream">Xem dạng bảng</summary>
              <table className="mt-3 w-full text-left">
                <caption className="sr-only">Doanh thu theo ngày</caption>
                <thead className="text-xs text-muted-foreground uppercase">
                  <tr>
                    <th scope="col" className="py-2">
                      Ngày
                    </th>
                    <th scope="col" className="py-2 text-right">
                      Doanh thu
                    </th>
                    <th scope="col" className="py-2 text-right">
                      Đơn
                    </th>
                    <th scope="col" className="py-2 text-right">
                      Vé
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 tabular-nums">
                  {revenue.data.days.map((row) => (
                    <tr key={row.date}>
                      <td className="py-1.5 text-cream">
                        {dayMonth(row.date)}/{row.date.slice(0, 4)}
                      </td>
                      <td className="py-1.5 text-right text-cream">{vnd(row.revenue)}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{row.bookings}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{row.tickets}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </section>

      <section aria-labelledby="occupancy-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="occupancy-heading" className="text-lg font-bold text-cream">
              Tỷ lệ lấp đầy theo suất chiếu
            </h2>
            <p className="text-sm text-muted-foreground">
              Ghế đã bán trên ghế bán được. Ghế đang giữ chưa tính, vì lượt giữ có thể hết hạn.
            </p>
          </div>
          <label className="space-y-1 text-sm">
            <span className="block text-muted-foreground">Ngày chiếu</span>
            <Input
              type="date"
              value={day}
              className="w-40"
              onChange={(event) => {
                if (event.target.value) setDay(event.target.value);
              }}
            />
          </label>
        </div>

        {occupancy.isPending ? (
          <div
            role="status"
            aria-label="Đang tải suất chiếu"
            className="h-48 animate-pulse rounded-2xl bg-white/5"
          />
        ) : occupancy.error ? (
          <ErrorState error={occupancy.error} onRetry={() => void occupancy.refetch()} />
        ) : occupancy.data.showtimes.length === 0 ? (
          <EmptyState title="Không có suất chiếu nào trong ngày này" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Tỷ lệ lấp đầy các suất chiếu trong ngày</caption>
              <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Giờ
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Phim
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Phòng
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Lấp đầy
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Đã bán
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Đang giữ
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {occupancy.data.showtimes.map((showtime) => (
                  <OccupancyRow key={showtime.id} showtime={showtime} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
