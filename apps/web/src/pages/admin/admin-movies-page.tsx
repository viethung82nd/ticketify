import type { AdminMovie } from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AdminShell } from '@/components/admin/admin-shell';
import { AgeBadge } from '@/components/catalog/movie-card';
import { MoviePoster } from '@/components/catalog/movie-poster';
import { Pagination } from '@/components/catalog/pagination';
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
import { FormAlert } from '@/features/auth/auth-card';
import { deleteMovie } from '@/features/catalog/catalog-api';
import { catalogErrorMessage } from '@/features/catalog/catalog-errors';
import { formatReleaseDate, STATUS_LABELS } from '@/features/catalog/movie-labels';
import { catalogKeys, useAdminMovies } from '@/features/catalog/use-catalog';
import { useMovieQuery } from '@/features/catalog/use-movie-query';

function DeleteMovieDialog({ movie, onClose }: { movie: AdminMovie | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => deleteMovie(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: catalogKeys.all });
      onClose();
    },
  });

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    mutation.reset();
    onClose();
  };

  return (
    <AlertDialog open={movie !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Xóa phim?</AlertDialogTitle>
        <AlertDialogDescription>
          Phim <strong className="text-cream">{movie?.title}</strong> và poster của phim sẽ bị xóa
          vĩnh viễn. Chỉ xóa được phim chưa có suất chiếu.
        </AlertDialogDescription>
        <FormAlert message={mutation.error ? catalogErrorMessage(mutation.error) : null} />
        <div className="flex justify-end gap-2 pt-2">
          <AlertDialogCancel asChild>
            <Button variant="outline" className="rounded-xl">
              Hủy
            </Button>
          </AlertDialogCancel>
          {/* Not AlertDialogAction: it would close the dialog before the result is known. */}
          <Button
            variant="destructive"
            className="rounded-xl"
            disabled={mutation.isPending}
            onClick={() => movie && mutation.mutate(movie.id)}
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Xóa phim
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AdminMoviesPage() {
  const [query, update] = useMovieQuery();
  const { data, isPending, error, refetch, isFetching } = useAdminMovies(query);
  const [toDelete, setToDelete] = useState<AdminMovie | null>(null);
  const [search, setSearch] = useState(query.q ?? '');

  return (
    <AdminShell
      title="Quản lý phim"
      description="Mọi trạng thái, mới khởi chiếu trước."
      actions={
        <Button asChild className="h-10 rounded-xl px-4 font-semibold">
          <Link to="/admin/movies/new">
            <Plus aria-hidden />
            Thêm phim
          </Link>
        </Button>
      }
    >
      <form
        role="search"
        className="mb-4 flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: search.trim() || undefined, page: undefined });
        }}
      >
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm theo tên phim…"
          aria-label="Tìm phim theo tên"
        />
        <Button type="submit" variant="outline" className="h-11 rounded-xl px-4">
          Tìm
        </Button>
      </form>

      {isPending ? (
        <div role="status" aria-label="Đang tải" className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState title="Chưa có phim nào">
          <Link to="/admin/movies/new" className="font-semibold text-brand hover:underline">
            Thêm phim đầu tiên
          </Link>
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <div
            className="overflow-x-auto rounded-2xl border border-white/10 bg-surface"
            aria-busy={isFetching}
          >
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Danh sách phim ({data.total})</caption>
              <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="w-16 px-4 py-3">
                    Poster
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Tên phim
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Trạng thái
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Độ tuổi
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Khởi chiếu
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    <span className="sr-only">Thao tác</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.items.map((movie) => (
                  <tr key={movie.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5">
                      <MoviePoster
                        title={movie.title}
                        posterUrl={movie.posterUrl}
                        size="sm"
                        className="w-10 rounded-md"
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-cream">{movie.title}</p>
                      <p className="text-xs text-muted-foreground">/{movie.slug}</p>
                    </td>
                    <td className="px-4 py-2.5 text-cream">{STATUS_LABELS[movie.status]}</td>
                    <td className="px-4 py-2.5">
                      <AgeBadge rating={movie.ageRating} />
                    </td>
                    <td className="px-4 py-2.5 text-cream tabular-nums">
                      {formatReleaseDate(movie.releaseDate)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button asChild variant="ghost" size="sm" className="rounded-lg">
                          <Link to={`/admin/movies/${movie.id}/edit`}>
                            <Pencil aria-hidden />
                            Sửa
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-lg text-destructive hover:text-destructive"
                          onClick={() => setToDelete(movie)}
                        >
                          <Trash2 aria-hidden />
                          Xóa
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={(page) => update({ page })}
          />
        </div>
      )}

      <DeleteMovieDialog movie={toDelete} onClose={() => setToDelete(null)} />
    </AdminShell>
  );
}
