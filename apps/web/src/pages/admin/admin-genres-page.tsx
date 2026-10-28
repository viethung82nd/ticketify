import { zodResolver } from '@hookform/resolvers/zod';
import {
  type AdminGenre,
  CATALOG_LIMITS,
  type GenreRequest,
  genreRequestSchema,
} from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
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
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { FormAlert } from '@/features/auth/auth-card';
import { createGenre, deleteGenre, renameGenre } from '@/features/catalog/catalog-api';
import { catalogErrorMessage } from '@/features/catalog/catalog-errors';
import { catalogKeys, useAdminGenres } from '@/features/catalog/use-catalog';

function useRefreshCatalog() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: catalogKeys.all });
}

function AddGenreForm() {
  const refresh = useRefreshCatalog();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(genreRequestSchema) });

  const onSubmit = async (values: GenreRequest) => {
    try {
      await createGenre(values);
      reset({ name: '' });
      await refresh();
    } catch (error) {
      setError('name', { message: catalogErrorMessage(error) });
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="mb-6 flex max-w-lg items-start gap-2"
    >
      <div className="flex-1">
        <FormField label="Thêm thể loại" error={errors.name}>
          <Input
            placeholder="Ví dụ: Hành động"
            maxLength={CATALOG_LIMITS.genreNameMax}
            {...register('name')}
          />
        </FormField>
      </div>
      <Button
        type="submit"
        disabled={isSubmitting}
        className="mt-7 h-11 rounded-xl px-4 font-semibold"
      >
        {isSubmitting ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
        Thêm
      </Button>
    </form>
  );
}

function GenreRow({ genre, onDelete }: { genre: AdminGenre; onDelete: () => void }) {
  const refresh = useRefreshCatalog();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(genre.name);
  const rename = useMutation({
    mutationFn: (body: GenreRequest) => renameGenre(genre.id, body),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
    },
  });
  const parsed = genreRequestSchema.safeParse({ name });
  const localError = editing && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const error = localError ?? (rename.error ? catalogErrorMessage(rename.error) : undefined);

  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsed.success) rename.mutate(parsed.data);
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={`Tên mới cho ${genre.name}`}
              aria-invalid={error ? true : undefined}
              maxLength={CATALOG_LIMITS.genreNameMax}
              className="h-9"
              autoFocus
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Lưu"
              disabled={rename.isPending || !parsed.success}
            >
              {rename.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Check aria-hidden />
              )}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Hủy"
              onClick={() => {
                setEditing(false);
                setName(genre.name);
                rename.reset();
              }}
            >
              <X aria-hidden />
            </Button>
          </form>
        ) : (
          <span className="font-medium text-cream">{genre.name}</span>
        )}
        {error && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{genre.slug}</td>
      <td className="px-4 py-3 text-cream tabular-nums">{genre.movieCount}</td>
      <td className="px-4 py-3">
        {!editing && (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg"
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden />
              Sửa
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
              Xóa
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function DeleteGenreDialog({ genre, onClose }: { genre: AdminGenre | null; onClose: () => void }) {
  const refresh = useRefreshCatalog();
  const mutation = useMutation({
    mutationFn: (id: string) => deleteGenre(id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  return (
    <AlertDialog
      open={genre !== null}
      onOpenChange={(open) => {
        if (open) return;
        mutation.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Xóa thể loại?</AlertDialogTitle>
        <AlertDialogDescription>
          Thể loại <strong className="text-cream">{genre?.name}</strong> sẽ bị xóa. Chỉ xóa được thể
          loại chưa gắn với phim nào.
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
            onClick={() => genre && mutation.mutate(genre.id)}
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Xóa thể loại
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AdminGenresPage() {
  const { data, isPending, error, refetch } = useAdminGenres();
  const [toDelete, setToDelete] = useState<AdminGenre | null>(null);

  return (
    <AdminShell title="Thể loại" description="Slug dùng trong bộ lọc phim, tự sinh từ tên.">
      <AddGenreForm />
      {isPending ? (
        <div
          role="status"
          aria-label="Đang tải"
          className="h-48 animate-pulse rounded-2xl bg-white/5"
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState title="Chưa có thể loại nào" />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
          <table className="w-full min-w-[560px] text-left text-sm">
            <caption className="sr-only">Danh sách thể loại</caption>
            <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Tên
                </th>
                <th scope="col" className="px-4 py-3">
                  Slug
                </th>
                <th scope="col" className="px-4 py-3">
                  Số phim
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.map((genre) => (
                <GenreRow key={genre.id} genre={genre} onDelete={() => setToDelete(genre)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeleteGenreDialog genre={toDelete} onClose={() => setToDelete(null)} />
    </AdminShell>
  );
}
