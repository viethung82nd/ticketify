import { CalendarDays, ChevronLeft, Clock, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { AgeBadge } from '@/components/catalog/movie-card';
import { MoviePoster } from '@/components/catalog/movie-poster';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { MovieSchedule } from '@/components/schedule/movie-schedule';
import { Button } from '@/components/ui/button';
import { errorCodeOf } from '@/features/catalog/catalog-errors';
import {
  AGE_RATING_LABELS,
  formatDuration,
  formatReleaseDate,
  STATUS_LABELS,
} from '@/features/catalog/movie-labels';
import { useMovie } from '@/features/catalog/use-catalog';

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-surface-raised p-3.5">
      <span className="mt-0.5 text-brand">{icon}</span>
      <div>
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="font-medium text-cream">{children}</dd>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-label="Đang tải phim" className="grid gap-8 md:grid-cols-[280px_1fr]">
      <div className="aspect-[2/3] animate-pulse rounded-2xl bg-white/5" />
      <div className="space-y-4">
        <div className="h-10 w-2/3 animate-pulse rounded bg-white/10" />
        <div className="h-5 w-1/3 animate-pulse rounded bg-white/5" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function MovieDetailPage() {
  const { slug = '' } = useParams();
  const { data: movie, isPending, error, refetch } = useMovie(slug);

  let body: ReactNode;
  if (isPending) {
    body = <DetailSkeleton />;
  } else if (errorCodeOf(error) === 'MOVIE_NOT_FOUND') {
    body = (
      <EmptyState title="Không tìm thấy phim">
        <p>Phim này không tồn tại hoặc đã bị gỡ.</p>
        <Button asChild variant="outline" className="mt-4 rounded-xl">
          <Link to="/movies">Xem danh sách phim</Link>
        </Button>
      </EmptyState>
    );
  } else if (error || !movie) {
    body = <ErrorState error={error} onRetry={() => void refetch()} />;
  } else {
    body = (
      <>
        <div className="grid gap-8 md:grid-cols-[280px_1fr]">
          <MoviePoster title={movie.title} posterUrl={movie.posterUrl} className="rounded-2xl" />
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <AgeBadge rating={movie.ageRating} />
                <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs text-cream">
                  {STATUS_LABELS[movie.status]}
                </span>
              </div>
              <h1 className="text-3xl leading-tight font-extrabold text-cream sm:text-5xl">
                {movie.title}
              </h1>
              {movie.genres.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label="Thể loại">
                  {movie.genres.map((genre) => (
                    <li key={genre.id}>
                      <Link
                        to={`/movies?genre=${genre.slug}`}
                        className="inline-block rounded-full border border-white/15 px-3 py-1 text-sm text-cream transition-colors hover:border-brand hover:text-brand"
                      >
                        {genre.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Fact icon={<Clock className="size-5" aria-hidden />} label="Thời lượng">
                {formatDuration(movie.duration)}
              </Fact>
              <Fact icon={<CalendarDays className="size-5" aria-hidden />} label="Khởi chiếu">
                {formatReleaseDate(movie.releaseDate)}
              </Fact>
              <Fact icon={<ShieldCheck className="size-5" aria-hidden />} label="Độ tuổi">
                {AGE_RATING_LABELS[movie.ageRating]}
              </Fact>
            </dl>
          </div>
        </div>

        {movie.synopsis && (
          <section aria-labelledby="noi-dung" className="mt-14 max-w-3xl space-y-3">
            <h2 id="noi-dung" className="text-2xl font-bold text-cream">
              Nội dung
            </h2>
            <p className="leading-relaxed whitespace-pre-line text-muted-foreground">
              {movie.synopsis}
            </p>
          </section>
        )}

        <section aria-labelledby="lich-chieu" className="mt-14 space-y-4">
          <h2 id="lich-chieu" className="text-2xl font-bold text-cream">
            Lịch chiếu
          </h2>
          <MovieSchedule movieId={movie.id} />
        </section>
      </>
    );
  }

  return (
    <section className="mx-auto max-w-6xl px-4 pt-10">
      <Link
        to="/movies"
        className="mb-6 inline-flex items-center gap-1 rounded-lg text-sm text-muted-foreground hover:text-cream"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Tất cả phim
      </Link>
      {body}
    </section>
  );
}
