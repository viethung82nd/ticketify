import { MovieStatus } from '@ticketify/shared';
import { Loader2, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MovieGrid } from '@/components/catalog/movie-grid';
import { Pagination } from '@/components/catalog/pagination';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { STATUS_LABELS } from '@/features/catalog/movie-labels';
import { useGenres, useMovies } from '@/features/catalog/use-catalog';
import { useMovieQuery } from '@/features/catalog/use-movie-query';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 300;

const TABS: { status: MovieStatus | undefined; label: string }[] = [
  { status: undefined, label: 'Tất cả' },
  { status: MovieStatus.NOW_SHOWING, label: STATUS_LABELS.NOW_SHOWING },
  { status: MovieStatus.COMING_SOON, label: STATUS_LABELS.COMING_SOON },
];

/** Search box that writes `q` to the URL 300 ms after the user stops typing. */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(initial);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleChange = (value: string) => {
    setText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onSearch(value.trim()), SEARCH_DEBOUNCE_MS);
  };

  return (
    <div className="relative flex-1 sm:max-w-xs">
      <Search
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Tìm theo tên phim…"
        aria-label="Tìm phim theo tên"
        maxLength={100}
        className="pl-10"
      />
    </div>
  );
}

export function MoviesPage() {
  const [query, update] = useMovieQuery();
  const movies = useMovies(query);
  const genres = useGenres();

  return (
    <section className="mx-auto max-w-6xl px-4 pt-12">
      <div className="space-y-1.5">
        <h1 className="text-3xl font-bold text-cream sm:text-4xl">Phim</h1>
        <p className="text-muted-foreground">
          Chọn phim bạn muốn xem, lịch chiếu sẽ có trên trang phim.
        </p>
      </div>

      <div className="mt-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Trạng thái phim"
          className="flex w-fit gap-1 rounded-2xl border border-white/10 bg-surface p-1"
        >
          {TABS.map((tab) => {
            const active = query.status === tab.status;
            return (
              <button
                key={tab.label}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => update({ status: tab.status, page: undefined })}
                className={cn(
                  'rounded-xl px-4 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  active ? 'bg-brand text-brand-foreground' : 'text-cream hover:bg-white/10',
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select
            aria-label="Lọc theo thể loại"
            value={query.genre ?? ''}
            onChange={(e) => update({ genre: e.target.value || undefined, page: undefined })}
            disabled={genres.isPending}
            className="sm:w-52"
          >
            <option value="">Tất cả thể loại</option>
            {genres.data?.map((genre) => (
              <option key={genre.id} value={genre.slug}>
                {genre.name}
              </option>
            ))}
          </Select>
          <SearchBox
            initial={query.q ?? ''}
            onSearch={(q) => update({ q: q || undefined, page: undefined }, { replace: true })}
          />
        </div>
      </div>

      <div className="mt-8 space-y-8" aria-busy={movies.isFetching}>
        <p className="flex h-5 items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          {movies.data && `${movies.data.total} phim`}
          {movies.isFetching && !movies.isPending && (
            <Loader2 className="size-4 animate-spin" aria-label="Đang tải" />
          )}
        </p>
        <MovieGrid
          movies={movies.data?.items}
          isPending={movies.isPending}
          error={movies.error}
          onRetry={() => void movies.refetch()}
          skeletonCount={12}
          empty="Không tìm thấy phim phù hợp. Thử đổi bộ lọc hoặc từ khóa."
        />
        {movies.data && (
          <Pagination
            page={movies.data.page}
            pageSize={movies.data.pageSize}
            total={movies.data.total}
            onPageChange={(page) => {
              update({ page });
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        )}
      </div>
    </section>
  );
}
