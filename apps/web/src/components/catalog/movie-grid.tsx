import type { Movie } from '@ticketify/shared';
import type { ReactNode } from 'react';
import { MovieCard, MovieCardSkeleton } from './movie-card';
import { EmptyState, ErrorState } from './query-states';

interface MovieGridProps {
  movies: Movie[] | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  skeletonCount?: number;
  empty: ReactNode;
}

const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4';

/** Grid of movie cards with loading (skeleton), error (retry) and empty states. */
export function MovieGrid({
  movies,
  isPending,
  error,
  onRetry,
  skeletonCount = 8,
  empty,
}: MovieGridProps) {
  if (isPending) {
    return (
      <div className={GRID} role="status" aria-label="Đang tải danh sách phim">
        {Array.from({ length: skeletonCount }, (_, i) => (
          <MovieCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!movies || movies.length === 0)
    return <EmptyState title="Không có phim nào">{empty}</EmptyState>;

  return (
    <ul className={GRID}>
      {movies.map((movie) => (
        <li key={movie.id}>
          <MovieCard movie={movie} />
        </li>
      ))}
    </ul>
  );
}
