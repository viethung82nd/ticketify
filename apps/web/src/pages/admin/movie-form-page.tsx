import { zodResolver } from '@hookform/resolvers/zod';
import {
  AgeRating,
  type AdminMovie,
  CATALOG_LIMITS,
  CatalogErrorCode,
  createMovieRequestSchema,
  MovieStatus,
  slugSchema,
  type UpdateMovieRequest,
} from '@ticketify/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, type FieldPath, useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import type { z } from 'zod';
import { AdminShell } from '@/components/admin/admin-shell';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormAlert } from '@/features/auth/auth-card';
import { createMovie, updateMovie } from '@/features/catalog/catalog-api';
import { catalogErrorMessage, errorCodeOf, errorFieldsOf } from '@/features/catalog/catalog-errors';
import { AGE_RATING_LABELS, STATUS_LABELS } from '@/features/catalog/movie-labels';
import { PosterUploader } from '@/features/catalog/poster-uploader';
import { catalogKeys, useAdminMovie, useGenres } from '@/features/catalog/use-catalog';

/** Create schema + the slug, which only the edit form shows. */
const movieFormSchema = createMovieRequestSchema.extend({ slug: slugSchema.optional() });
type MovieFormInput = z.input<typeof movieFormSchema>;
type MovieFormValues = z.output<typeof movieFormSchema>;

const FORM_FIELDS: FieldPath<MovieFormInput>[] = [
  'title',
  'slug',
  'duration',
  'ageRating',
  'status',
  'releaseDate',
  'genreIds',
  'posterKey',
];
const isFormField = (field: string): field is FieldPath<MovieFormInput> =>
  (FORM_FIELDS as string[]).includes(field);

/** Field that an API error code is about, if any. */
const FIELD_OF_CODE: Partial<Record<string, FieldPath<MovieFormInput>>> = {
  [CatalogErrorCode.SLUG_TAKEN]: 'slug',
  [CatalogErrorCode.INVALID_GENRES]: 'genreIds',
  [CatalogErrorCode.POSTER_NOT_UPLOADED]: 'posterKey',
};

function MovieForm({ movie }: { movie?: AdminMovie }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const genres = useGenres();
  const [formError, setFormError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<MovieFormInput, unknown, MovieFormValues>({
    resolver: zodResolver(movieFormSchema),
    defaultValues: movie
      ? {
          title: movie.title,
          slug: movie.slug,
          duration: movie.duration,
          ageRating: movie.ageRating,
          status: movie.status,
          releaseDate: movie.releaseDate,
          genreIds: movie.genres.map((genre) => genre.id),
          posterKey: movie.posterKey,
        }
      : { status: MovieStatus.COMING_SOON, genreIds: [], posterKey: null },
  });

  const onSubmit = async (values: MovieFormValues) => {
    setFormError(null);
    const { slug, posterKey, ...fields } = values;
    try {
      if (movie) {
        const body: UpdateMovieRequest = { ...fields };
        // Only send what changed: an unchanged poster needs no storage round-trip.
        if (slug !== undefined && slug !== movie.slug) body.slug = slug;
        if ((posterKey ?? null) !== movie.posterKey) body.posterKey = posterKey ?? null;
        await updateMovie(movie.id, body);
      } else {
        await createMovie({ ...fields, posterKey: posterKey ?? null });
      }
      await queryClient.invalidateQueries({ queryKey: catalogKeys.all });
      await navigate('/admin/movies');
    } catch (error) {
      const code = errorCodeOf(error);
      const message = catalogErrorMessage(error);
      const codeField = code ? FIELD_OF_CODE[code] : undefined;
      if (codeField) {
        setError(codeField, { message });
        return;
      }
      const fields = errorFieldsOf(error).filter(isFormField);
      for (const field of fields) setError(field, { message: 'Giá trị không hợp lệ.' });
      setFormError(message);
    }
  };

  const title = useWatch({ control, name: 'title' }) ?? '';

  return (
    <form
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="grid gap-8 rounded-2xl border border-white/10 bg-surface p-6 lg:grid-cols-[1fr_280px]"
    >
      <div className="space-y-5">
        <FormAlert message={formError} />
        <FormField label="Tên phim" error={errors.title}>
          <Input maxLength={CATALOG_LIMITS.titleMax} {...register('title')} />
        </FormField>
        {movie && (
          <FormField
            label="Slug (đường dẫn)"
            error={errors.slug}
            hint="Không tự đổi theo tên phim. Đổi slug làm hỏng các liên kết cũ."
          >
            <Input {...register('slug')} />
          </FormField>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label="Thời lượng (phút)" error={errors.duration}>
            <Input
              type="number"
              inputMode="numeric"
              min={CATALOG_LIMITS.durationMin}
              max={CATALOG_LIMITS.durationMax}
              {...register('duration', { valueAsNumber: true })}
            />
          </FormField>
          <FormField label="Ngày khởi chiếu" error={errors.releaseDate}>
            <Input type="date" {...register('releaseDate')} />
          </FormField>
          <FormField label="Độ tuổi" error={errors.ageRating}>
            <Select defaultValue="" {...register('ageRating')}>
              <option value="" disabled>
                Chọn phân loại…
              </option>
              {Object.values(AgeRating).map((rating) => (
                <option key={rating} value={rating}>
                  {AGE_RATING_LABELS[rating]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Trạng thái" error={errors.status}>
            <Select {...register('status')}>
              {Object.values(MovieStatus).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <Controller
          control={control}
          name="genreIds"
          render={({ field, fieldState }) => (
            <fieldset className="space-y-2" aria-describedby="genre-help">
              <legend className="text-sm font-medium text-cream">Thể loại</legend>
              <p id="genre-help" className="text-xs text-muted-foreground">
                Chọn tối đa {CATALOG_LIMITS.genresPerMovieMax} thể loại.
              </p>
              {genres.isPending && <p className="text-sm text-muted-foreground">Đang tải…</p>}
              {genres.error && (
                <p className="text-sm text-destructive">Không tải được danh sách thể loại.</p>
              )}
              <div className="flex flex-wrap gap-2">
                {genres.data?.map((genre) => {
                  const checked = field.value.includes(genre.id);
                  return (
                    <label
                      key={genre.id}
                      className="flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-sm text-cream has-checked:border-brand has-checked:bg-brand/10 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--brand)]"
                        checked={checked}
                        onChange={() =>
                          field.onChange(
                            checked
                              ? field.value.filter((id) => id !== genre.id)
                              : [...field.value, genre.id],
                          )
                        }
                      />
                      {genre.name}
                    </label>
                  );
                })}
              </div>
              {fieldState.error && (
                <p role="alert" className="text-sm text-destructive">
                  {fieldState.error.message}
                </p>
              )}
            </fieldset>
          )}
        />

        <div className="flex flex-wrap gap-3 pt-2">
          <Button
            type="submit"
            disabled={isSubmitting || uploading}
            className="h-11 rounded-xl px-6 font-semibold"
          >
            {isSubmitting && <Loader2 className="animate-spin" aria-hidden />}
            {movie ? 'Lưu thay đổi' : 'Tạo phim'}
          </Button>
          <Button asChild variant="ghost" className="h-11 rounded-xl">
            <Link to="/admin/movies">Hủy</Link>
          </Button>
        </div>
      </div>

      <Controller
        control={control}
        name="posterKey"
        render={({ field, fieldState }) => (
          <PosterUploader
            title={title}
            value={field.value}
            savedKey={movie?.posterKey ?? null}
            savedUrl={movie?.posterUrl ?? null}
            onChange={field.onChange}
            onUploadingChange={setUploading}
            error={fieldState.error?.message}
          />
        )}
      />
    </form>
  );
}

export function NewMoviePage() {
  return (
    <AdminShell title="Thêm phim">
      <MovieForm />
    </AdminShell>
  );
}

export function EditMoviePage() {
  const { id = '' } = useParams();
  const { data: movie, isPending, error, refetch } = useAdminMovie(id);

  return (
    <AdminShell title={movie ? `Sửa phim: ${movie.title}` : 'Sửa phim'}>
      {isPending ? (
        <div
          role="status"
          aria-label="Đang tải"
          className="h-96 animate-pulse rounded-2xl bg-white/5"
        />
      ) : errorCodeOf(error) === CatalogErrorCode.MOVIE_NOT_FOUND ? (
        <EmptyState title="Không tìm thấy phim">
          <Link to="/admin/movies" className="font-semibold text-brand hover:underline">
            Về danh sách phim
          </Link>
        </EmptyState>
      ) : error || !movie ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        // Re-mount when the saved movie changes so the form starts from fresh values.
        <MovieForm key={movie.updatedAt} movie={movie} />
      )}
    </AdminShell>
  );
}
