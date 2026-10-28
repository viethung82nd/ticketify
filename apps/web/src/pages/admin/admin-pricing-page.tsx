import {
  DAY_TYPE_ORDER,
  DayType,
  formatVnd,
  type Holiday,
  holidayRequestSchema,
  PRICING_LIMITS,
  PricingErrorCode,
  SEAT_TYPE_ORDER,
  type SeatPrice,
  seatPriceRequestSchema,
  SeatType,
} from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage, errorCodeOf } from '@/features/catalog/catalog-errors';
import { formatReleaseDate } from '@/features/catalog/movie-labels';
import {
  createHoliday,
  deleteHoliday,
  pricingKeys,
  updateSeatPrice,
  useHolidays,
  useSeatPrices,
} from '@/features/pricing/pricing-api';

const SEAT_TYPE_NAMES: Record<SeatType, string> = {
  [SeatType.STANDARD]: 'Ghế thường',
  [SeatType.VIP]: 'Ghế VIP',
  [SeatType.COUPLE]: 'Ghế đôi',
};
const DAY_TYPE_NAMES: Record<DayType, string> = {
  [DayType.WEEKDAY]: 'Ngày thường',
  [DayType.WEEKEND]: 'Cuối tuần',
  [DayType.HOLIDAY]: 'Ngày lễ',
};
const DAY_TYPE_HINTS: Record<DayType, string> = {
  [DayType.WEEKDAY]: 'Thứ Hai – thứ Sáu',
  [DayType.WEEKEND]: 'Thứ Bảy, Chủ nhật',
  [DayType.HOLIDAY]: 'Ngày trong danh sách bên dưới',
};

type CellKey = `${SeatType}/${DayType}`;
const keyOf = (seatType: SeatType, dayType: DayType): CellKey => `${seatType}/${dayType}`;

/** Digits only → the number, or `null` for an empty input. */
const parseVnd = (text: string): number | null => {
  const digits = text.replace(/\D/g, '');
  return digits === '' ? null : Number(digits);
};

function priceError(text: string): string | undefined {
  const parsed = seatPriceRequestSchema.safeParse({ price: parseVnd(text) ?? undefined });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

// ─── Price table ───

function PriceTable({ prices }: { prices: SeatPrice[] }) {
  const queryClient = useQueryClient();
  const saved = new Map(prices.map((p) => [keyOf(p.seatType, p.dayType), p.price]));
  const [texts, setTexts] = useState<Partial<Record<CellKey, string>>>({});
  const [serverErrors, setServerErrors] = useState<Partial<Record<CellKey, string>>>({});
  const [saving, setSaving] = useState<Set<CellKey>>(new Set());
  const [justSaved, setJustSaved] = useState<Set<CellKey>>(new Set());

  const textOf = (key: CellKey) => texts[key] ?? formatVnd(saved.get(key) ?? 0);
  const isDirty = (key: CellKey) =>
    texts[key] !== undefined && parseVnd(texts[key]) !== saved.get(key);
  const cells = SEAT_TYPE_ORDER.flatMap((s) =>
    DAY_TYPE_ORDER.filter((d) => saved.has(keyOf(s, d))).map((d) => [s, d] as const),
  );
  const dirty = cells.filter(([s, d]) => isDirty(keyOf(s, d)));
  const anyInvalid = dirty.some(([s, d]) => priceError(textOf(keyOf(s, d))) !== undefined);

  async function saveCell(seatType: SeatType, dayType: DayType): Promise<void> {
    const key = keyOf(seatType, dayType);
    const price = parseVnd(textOf(key));
    if (price === null || priceError(textOf(key))) return;
    setSaving((s) => new Set(s).add(key));
    try {
      const row = await updateSeatPrice(seatType, dayType, { price });
      queryClient.setQueryData<SeatPrice[]>(pricingKeys.prices, (old) =>
        old?.map((p) => (p.seatType === seatType && p.dayType === dayType ? row : p)),
      );
      setTexts(({ [key]: _done, ...rest }) => rest);
      setServerErrors(({ [key]: _done, ...rest }) => rest);
      setJustSaved((s) => new Set(s).add(key));
    } catch (error) {
      setServerErrors((e) => ({ ...e, [key]: catalogErrorMessage(error) }));
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  const saveAll = async () => {
    for (const [s, d] of dirty) await saveCell(s, d);
  };

  return (
    <section aria-labelledby="price-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="price-heading" className="text-lg font-bold text-cream">
            Bảng giá vé
          </h2>
          <p className="text-sm text-muted-foreground">
            Giá mỗi ghế (VND), từ {formatVnd(PRICING_LIMITS.priceMin)} ₫ đến{' '}
            {formatVnd(PRICING_LIMITS.priceMax)} ₫. Đổi giá chỉ áp dụng cho suất chiếu tạo sau đó;
            suất đã tạo giữ giá đã chốt.
          </p>
        </div>
        <Button
          type="button"
          className="h-10 rounded-xl px-4 font-semibold"
          disabled={dirty.length === 0 || anyInvalid || saving.size > 0}
          onClick={() => void saveAll()}
        >
          {saving.size > 0 ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Save aria-hidden />
          )}
          Lưu cả bảng{dirty.length > 0 ? ` (${dirty.length})` : ''}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Giá vé theo loại ghế và loại ngày</caption>
          <thead className="border-b border-white/10">
            <tr>
              <th scope="col" className="px-4 py-3 text-xs text-muted-foreground uppercase">
                Loại ghế
              </th>
              {DAY_TYPE_ORDER.map((dayType) => (
                <th key={dayType} scope="col" className="px-4 py-3">
                  <span className="block font-semibold text-cream">{DAY_TYPE_NAMES[dayType]}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {DAY_TYPE_HINTS[dayType]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {SEAT_TYPE_ORDER.map((seatType) => (
              <tr key={seatType} className="align-top">
                <th scope="row" className="px-4 py-4 font-medium text-cream">
                  {SEAT_TYPE_NAMES[seatType]}
                  {seatType === SeatType.COUPLE && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      Giá mỗi ghế, cặp = 2 ghế
                    </span>
                  )}
                </th>
                {DAY_TYPE_ORDER.map((dayType) => {
                  const key = keyOf(seatType, dayType);
                  if (!saved.has(key)) {
                    return (
                      <td key={dayType} className="px-4 py-4 text-muted-foreground">
                        Chưa có dữ liệu
                      </td>
                    );
                  }
                  const text = textOf(key);
                  const error = (isDirty(key) ? priceError(text) : undefined) ?? serverErrors[key];
                  const errorId = `price-error-${key}`;
                  return (
                    <td key={dayType} className="px-4 py-3">
                      <form
                        className="flex items-center gap-1.5"
                        onSubmit={(e: FormEvent) => {
                          e.preventDefault();
                          void saveCell(seatType, dayType);
                        }}
                      >
                        <div className="relative w-36">
                          <Input
                            inputMode="numeric"
                            value={text}
                            aria-label={`Giá ${SEAT_TYPE_NAMES[seatType]}, ${DAY_TYPE_NAMES[dayType]}`}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={error ? errorId : undefined}
                            onChange={(e) => {
                              const value = parseVnd(e.target.value);
                              setTexts((t) => ({
                                ...t,
                                [key]: value === null ? '' : formatVnd(value),
                              }));
                              setServerErrors(({ [key]: _old, ...rest }) => rest);
                              setJustSaved((s) => {
                                const next = new Set(s);
                                next.delete(key);
                                return next;
                              });
                            }}
                            className="h-10 pr-8 text-right tabular-nums"
                          />
                          <span
                            aria-hidden
                            className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground"
                          >
                            ₫
                          </span>
                        </div>
                        <Button
                          type="submit"
                          size="icon"
                          variant={isDirty(key) ? 'default' : 'ghost'}
                          aria-label={`Lưu giá ${SEAT_TYPE_NAMES[seatType]}, ${DAY_TYPE_NAMES[dayType]}`}
                          disabled={
                            !isDirty(key) || priceError(text) !== undefined || saving.has(key)
                          }
                          className="size-10 rounded-xl"
                        >
                          {saving.has(key) ? (
                            <Loader2 className="animate-spin" aria-hidden />
                          ) : (
                            <Check aria-hidden />
                          )}
                        </Button>
                      </form>
                      {error ? (
                        <p id={errorId} className="mt-1 text-xs text-destructive">
                          {error}
                        </p>
                      ) : justSaved.has(key) ? (
                        <p role="status" className="mt-1 text-xs text-muted-foreground">
                          Đã lưu
                        </p>
                      ) : isDirty(key) ? (
                        <p className="mt-1 text-xs text-muted-foreground">Chưa lưu</p>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Holidays ───

/** Current year on the cinema's calendar. */
const cinemaYear = (): number =>
  Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric' }).format(
      new Date(),
    ),
  );

/** `2026-09-02` → `Thứ Tư`; a calendar date, so formatted in UTC to avoid any shift. */
const weekdayOf = (isoDate: string): string =>
  new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );

function AddHolidayForm({ onAdded }: { onAdded: (date: string) => void }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: createHoliday,
    onSuccess: async (holiday) => {
      await queryClient.invalidateQueries({ queryKey: ['pricing', 'holidays'] });
      setDate('');
      onAdded(holiday.date);
    },
    onError: (err) => {
      setError(
        errorCodeOf(err) === PricingErrorCode.HOLIDAY_EXISTS
          ? `Ngày ${formatReleaseDate(date)} đã có trong danh sách ngày lễ.`
          : catalogErrorMessage(err),
      );
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = holidayRequestSchema.safeParse({ date });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Ngày không hợp lệ');
      return;
    }
    setError(null);
    mutation.mutate(parsed.data);
  };

  return (
    <form noValidate onSubmit={submit} className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-cream">
        Thêm ngày lễ
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          type="date"
          value={date}
          min={`${PRICING_LIMITS.yearMin}-01-01`}
          max={`${PRICING_LIMITS.yearMax}-12-31`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(e) => {
            setDate(e.target.value);
            setError(null);
          }}
          className="w-48"
        />
        <Button
          type="submit"
          disabled={mutation.isPending}
          className="h-11 rounded-xl px-4 font-semibold"
        >
          {mutation.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Plus aria-hidden />
          )}
          Thêm
        </Button>
      </div>
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function DeleteHolidayDialog({
  holiday,
  onClose,
}: {
  holiday: Holiday | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => deleteHoliday(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['pricing', 'holidays'] });
      onClose();
    },
  });
  return (
    <AlertDialog
      open={holiday !== null}
      onOpenChange={(open) => {
        if (open) return;
        mutation.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Xóa ngày lễ?</AlertDialogTitle>
        <AlertDialogDescription>
          Ngày{' '}
          <strong className="text-cream">{holiday ? formatReleaseDate(holiday.date) : ''}</strong>{' '}
          sẽ không còn tính giá ngày lễ cho các suất chiếu tạo sau này. Suất đã tạo giữ giá đã chốt.
        </AlertDialogDescription>
        <FormAlert message={mutation.error ? catalogErrorMessage(mutation.error) : null} />
        <div className="flex justify-end gap-2 pt-2">
          <AlertDialogCancel asChild>
            <Button variant="outline" className="rounded-xl">
              Hủy
            </Button>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            className="rounded-xl"
            disabled={mutation.isPending}
            onClick={() => holiday && mutation.mutate(holiday.id)}
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Xóa ngày lễ
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function HolidaySection() {
  const thisYear = cinemaYear();
  const [year, setYear] = useState(thisYear);
  const { data, isPending, error, refetch } = useHolidays(year);
  const [toDelete, setToDelete] = useState<Holiday | null>(null);
  const years = Array.from({ length: 6 }, (_, i) => thisYear - 1 + i);
  if (!years.includes(year)) years.push(year);

  return (
    <section aria-labelledby="holiday-heading" className="space-y-4">
      <div>
        <h2 id="holiday-heading" className="text-lg font-bold text-cream">
          Ngày lễ
        </h2>
        <p className="text-sm text-muted-foreground">
          Suất chiếu bắt đầu trong ngày lễ (giờ Việt Nam) tính giá ngày lễ, kể cả khi rơi vào cuối
          tuần.
        </p>
      </div>
      <div className="grid gap-6 rounded-2xl border border-white/10 bg-surface p-5 md:grid-cols-[1fr_280px]">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label htmlFor="holiday-year" className="text-sm font-medium text-cream">
              Năm
            </label>
            <Select
              id="holiday-year"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="h-10 w-28"
            >
              {years
                .sort((a, b) => a - b)
                .map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
            </Select>
          </div>
          {isPending ? (
            <div
              role="status"
              aria-label="Đang tải"
              className="h-24 animate-pulse rounded-xl bg-white/5"
            />
          ) : error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : data.length === 0 ? (
            <EmptyState title={`Chưa có ngày lễ nào trong năm ${year}`} />
          ) : (
            <ul
              aria-label={`Ngày lễ năm ${year}`}
              className="divide-y divide-white/5 rounded-xl border border-white/10"
            >
              {data.map((holiday) => (
                <li
                  key={holiday.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <span className="text-cream">
                    <span className="font-medium tabular-nums">
                      {formatReleaseDate(holiday.date)}
                    </span>
                    <span className="ml-2 text-sm text-muted-foreground capitalize">
                      {weekdayOf(holiday.date)}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-lg text-destructive hover:text-destructive"
                    aria-label={`Xóa ngày lễ ${formatReleaseDate(holiday.date)}`}
                    onClick={() => setToDelete(holiday)}
                  >
                    <Trash2 aria-hidden />
                    Xóa
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <AddHolidayForm onAdded={(date) => setYear(Number(date.slice(0, 4)))} />
      </div>
      <DeleteHolidayDialog holiday={toDelete} onClose={() => setToDelete(null)} />
    </section>
  );
}

export function AdminPricingPage() {
  const { data, isPending, error, refetch } = useSeatPrices();
  return (
    <AdminShell
      title="Giá vé & ngày lễ"
      description="Giá theo loại ghế × loại ngày, tính theo giờ Việt Nam."
    >
      <div className="space-y-10 pb-10">
        {isPending ? (
          <div
            role="status"
            aria-label="Đang tải"
            className="h-64 animate-pulse rounded-2xl bg-white/5"
          />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : (
          <PriceTable prices={data} />
        )}
        <HolidaySection />
      </div>
    </AdminShell>
  );
}
