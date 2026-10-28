import type { AgeRating, Movie } from '@ticketify/shared';
import { Clock } from 'lucide-react';
import { Link } from 'react-router';
import { formatDuration } from '@/features/catalog/movie-labels';
import { cn } from '@/lib/utils';
import { MoviePoster } from './movie-poster';

/** Small yellow-on-black rating chip (P, K, T13…). */
export function AgeBadge({ rating, className }: { rating: AgeRating; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-md bg-black/75 px-1.5 text-xs font-bold text-brand ring-1 ring-brand/40',
        className,
      )}
      title={`Phân loại ${rating}`}
    >
      {rating}
    </span>
  );
}

export function DurationBadge({ minutes }: { minutes: number }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-md bg-white/10 px-1.5 text-xs text-cream">
      <Clock className="size-3" aria-hidden />
      {formatDuration(minutes)}
    </span>
  );
}

export function MovieCard({ movie }: { movie: Movie }) {
  return (
    <Link
      to={`/movies/${movie.slug}`}
      className="group block h-full rounded-2xl bg-surface p-2 transition-colors outline-none hover:bg-surface-raised focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <div className="relative">
        <MoviePoster
          title={movie.title}
          posterUrl={movie.posterUrl}
          className="transition-transform duration-300 group-hover:scale-[1.02]"
        />
        <AgeBadge rating={movie.ageRating} className="absolute top-2 left-2" />
      </div>
      <div className="space-y-2 px-1.5 pt-3 pb-1.5">
        <h3 className="line-clamp-2 min-h-[2.75rem] leading-snug font-semibold text-cream">
          {movie.title}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <DurationBadge minutes={movie.duration} />
          {movie.genres[0] && (
            <span className="truncate text-xs text-muted-foreground">
              {movie.genres.map((genre) => genre.name).join(', ')}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

export function MovieCardSkeleton() {
  return (
    <div className="rounded-2xl bg-surface p-2" aria-hidden>
      <div className="aspect-[2/3] animate-pulse rounded-xl bg-white/5" />
      <div className="space-y-2 px-1.5 pt-3 pb-1.5">
        <div className="h-4 w-3/4 animate-pulse rounded bg-white/10" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-white/5" />
      </div>
    </div>
  );
}
