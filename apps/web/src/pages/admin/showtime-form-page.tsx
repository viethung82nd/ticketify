import { zodResolver } from '@hookform/resolvers/zod';
import {
  CATALOG_LIMITS,
  CatalogErrorCode,
  type CreateShowtimeRequest,
  DayType,
  isIsoDate,
  MovieStatus,
  RoomErrorCode,
  type ShowtimeConflict,
  showtimeConflictSchema,
  ShowtimeErrorCode,
} from '@ticketify/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type FieldPath, useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { AdminShell } from '@/components/admin/admin-shell';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage, errorCodeOf, errorFieldsOf } from '@/features/catalog/catalog-errors';
import { useAdminMovies } from '@/features/catalog/use-catalog';
import { useRooms } from '@/features/rooms/use-rooms';
import {
  createShowtime,
  showtimeKeys,
  useShowtimePreview,
} from '@/features/showtimes/showtimes-api';
import { apiErrorOf } from '@/lib/api-error';
import { cinemaDate, cinemaIso, cinemaTime, cinemaToday, longDayLabel } from '@/lib/cinema-time';

const DAY_TYPE_NAMES: Record<DayType, string> = {
  [DayType.WEEKDAY]: 'Ngày thường',
  [DayType.WEEKEND]: 'Cuối tuần',
  [DayType.HOLIDAY]: 'Ngày lễ',
};

/** Date and time are typed on the cinema's wall clock, then sent as ISO with its offset. */
const formSchema = z.object({
  movieId: z.string().min(1, { error: 'Vui lòng chọn phim' }),
  roomId: z.string().min(1, { error: 'Vui lòng chọn phòng' }),
  date: z.string().refine(isIsoDate, { error: 'Vui lòng chọn ngày chiếu' }),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Vui lòng nhập giờ bắt đầu' }),
});
type FormValues = z.infer<typeof formSchema>;

const FIELD_OF_CODE: Partial<Record<string, FieldPath<FormValues>>> = {
  [CatalogErrorCode.MOVIE_NOT_FOUND]: 'movieId',
  [ShowtimeErrorCode.MOVIE_ENDED]: 'movieId',
  [RoomErrorCode.ROOM_NOT_FOUND]: 'roomId',
};

const PAST_START = 'Giờ bắt đầu phải sau thời điểm hiện tại.';

const conflictsOf = (error: unknown): ShowtimeConflict[] => {
  const parsed = z
    .object({ conflicts: z.array(showtimeConflictSchema) })
    .safeParse(apiErrorOf(error)?.details);
  return parsed.success ? parsed.data.conflicts : [];
};

/** `value`, updated only after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function ConflictList({ conflicts }: { conflicts: ShowtimeConflict[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {conflicts.map((conflict) => (
        <li key={conflict.id} className="text-sm text-cream">
          <span className="font-medium">{conflict.movieTitle}</span>{' '}
          <span className="tabular-nums">
            {cinemaTime(conflict.startsAt)}–{cinemaTime(conflict.endsAt)}
          </span>
          {cinemaDate(conflict.startsAt) !== cinemaDate(conflict.endsAt) && (
            <span className="text-muted-foreground"> (qua nửa đêm)</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Live preview of what would be created: end time, price day, overlaps. */
function PreviewPanel({ params }: { params: CreateShowtimeRequest | null }) {
  const preview = useShowtimePreview(params);

  let content;
  if (!params) {
    content = (
      <p className="text-sm text-muted-foreground">
        Chọn phim, phòng, ngày và giờ để xem giờ kết thúc.
      </p>
    );
  } else if (preview.isPending) {
    content = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Đang kiểm tra…
      </p>
    );
  } else if (preview.isError) {
    content = (
      <p className="text-sm text-destructive">
        {errorCodeOf(preview.error) === 'VALIDATION_FAILED'
          ? PAST_START
          : catalogErrorMessage(preview.error)}
      </p>
    );
  } else {
    const { endsAt, startsAt, cleanupMinutes, dayType, conflicts } = preview.data;
    const nextDay = cinemaDate(endsAt) !== cinemaDate(startsAt);
    content = (
      <div className="space-y-3">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Kết thúc (gồm dọn phòng)</dt>
            <dd data-testid="preview-ends-at" className="text-xl font-bold text-cream tabular-nums">
              {cinemaTime(endsAt)}
              {nextDay && <span className="ml-1 text-xs font-normal">(+1 ngày)</span>}
            </dd>
            <dd className="text-xs text-muted-foreground">{cleanupMinutes} phút dọn phòng</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Giá vé áp dụng</dt>
            <dd className="text-xl font-bold text-cream">{DAY_TYPE_NAMES[dayType]}</dd>
          </div>
        </dl>
        {conflicts.length > 0 && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5"
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <AlertTriangle className="size-4" aria-hidden />
              Trùng giờ với suất đang có trong phòng:
            </p>
            <ConflictList conflicts={conflicts} />
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      aria-label="Xem trước"
      className="space-y-3 rounded-2xl border border-white/10 bg-surface-raised p-5"
    >
      <h2 className="flex items-center gap-2 font-semibold text-cream">
        <CalendarClock className="size-4 text-brand" aria-hidden /> Xem trước
      </h2>
      {content}
    </aside>
  );
}

export function NewShowtimePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const initialDate = params.get('date') ?? '';
  const movies = useAdminMovies({ page: 1, pageSize: CATALOG_LIMITS.pageSizeMax });
  const rooms = useRooms();
  const [formError, setFormError] = useState<string | null>(null);
  // The overlap error belongs to the values it was returned for; editing any field hides it.
  const [overlap, setOverlap] = useState<{ key: string; conflicts: ShowtimeConflict[] } | null>(
    null,
  );

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      movieId: '',
      roomId: '',
      date: isIsoDate(initialDate) ? initialDate : cinemaToday(),
      time: '',
    },
  });

  const [movieId, roomId, date, time] = useWatch({
    control,
    name: ['movieId', 'roomId', 'date', 'time'],
  });
  const startsAt = cinemaIso(date, time);
  const live = movieId && roomId && startsAt ? { movieId, roomId, startsAt } : null;
  const debounced = useDebounced(live, 300);
  // Never show a preview for values the form no longer has.
  const previewParams =
    debounced && live && JSON.stringify(debounced) === JSON.stringify(live) ? debounced : null;

  const valuesKey = JSON.stringify([movieId, roomId, date, time]);
  const shownOverlap = overlap?.key === valuesKey ? overlap.conflicts : null;

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    setOverlap(null);
    const iso = cinemaIso(values.date, values.time);
    if (!iso) return;
    try {
      await createShowtime({ movieId: values.movieId, roomId: values.roomId, startsAt: iso });
      await queryClient.invalidateQueries({ queryKey: showtimeKeys.all });
      await navigate(`/admin/showtimes?date=${values.date}`);
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === ShowtimeErrorCode.SHOWTIME_OVERLAP) {
        setOverlap({
          key: JSON.stringify([values.movieId, values.roomId, values.date, values.time]),
          conflicts: conflictsOf(error),
        });
        await queryClient.invalidateQueries({ queryKey: ['showtimes', 'preview'] });
        return;
      }
      const field = code ? FIELD_OF_CODE[code] : undefined;
      if (field) {
        setError(field, { message: catalogErrorMessage(error) });
        return;
      }
      if (code === 'VALIDATION_FAILED' && errorFieldsOf(error).includes('startsAt')) {
        setError('time', { message: PAST_START });
        return;
      }
      setFormError(catalogErrorMessage(error));
    }
  };

  const schedulable = movies.data?.items.filter((movie) => movie.status !== MovieStatus.ENDED);

  return (
    <AdminShell
      title="Thêm suất chiếu"
      description="Ngày và giờ theo giờ Việt Nam (GMT+7), không theo múi giờ của máy bạn."
    >
      <div className="grid gap-6 pb-10 lg:grid-cols-[1fr_320px]">
        <form
          noValidate
          aria-label="Thêm suất chiếu"
          onSubmit={(e) => void handleSubmit(onSubmit)(e)}
          className="space-y-5 rounded-2xl border border-white/10 bg-surface p-6"
        >
          <FormAlert message={formError} />
          <FormField
            label="Phim"
            error={errors.movieId}
            hint="Phim đã kết thúc không xếp được suất mới."
          >
            <Select {...register('movieId')} disabled={movies.isPending}>
              <option value="">{movies.isPending ? 'Đang tải…' : 'Chọn phim…'}</option>
              {schedulable?.map((movie) => (
                <option key={movie.id} value={movie.id}>
                  {movie.title} ({movie.duration} phút)
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Phòng" error={errors.roomId}>
            <Select {...register('roomId')} disabled={rooms.isPending}>
              <option value="">{rooms.isPending ? 'Đang tải…' : 'Chọn phòng…'}</option>
              {rooms.data?.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name} ({room.activeSeatCount} ghế)
                </option>
              ))}
            </Select>
          </FormField>
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              label="Ngày chiếu"
              error={errors.date}
              hint={isIsoDate(date) ? longDayLabel(date) : undefined}
            >
              <Input type="date" min={cinemaToday()} {...register('date')} />
            </FormField>
            <FormField label="Giờ bắt đầu" error={errors.time} hint="Theo giờ Việt Nam (GMT+7).">
              <Input type="time" step={300} {...register('time')} />
            </FormField>
          </div>

          <div className="flex gap-3 pt-2">
            <Button
              type="submit"
              disabled={isSubmitting}
              className="h-11 rounded-xl px-5 font-semibold"
            >
              {isSubmitting && <Loader2 className="animate-spin" aria-hidden />}
              Tạo suất chiếu
            </Button>
            <Button asChild variant="outline" className="h-11 rounded-xl px-5">
              <Link to={`/admin/showtimes?date=${isIsoDate(date) ? date : cinemaToday()}`}>
                Hủy
              </Link>
            </Button>
          </div>

          {shownOverlap && (
            <div
              id="overlap-error"
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5"
            >
              <p className="text-sm font-semibold text-destructive">
                Không tạo được: phòng đã có suất chiếu khác trong khoảng giờ này.
              </p>
              {shownOverlap.length > 0 && <ConflictList conflicts={shownOverlap} />}
            </div>
          )}
        </form>
        <PreviewPanel params={previewParams} />
      </div>
    </AdminShell>
  );
}
