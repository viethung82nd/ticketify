import type { AdminRoomSummary } from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
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
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage } from '@/features/catalog/catalog-errors';
import { deleteRoom } from '@/features/rooms/rooms-api';
import { roomKeys, useRooms } from '@/features/rooms/use-rooms';

function DeleteRoomDialog({
  room,
  onClose,
}: {
  room: AdminRoomSummary | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => deleteRoom(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: roomKeys.all });
      onClose();
    },
  });

  return (
    <AlertDialog
      open={room !== null}
      onOpenChange={(open) => {
        if (open) return;
        mutation.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Xóa phòng?</AlertDialogTitle>
        <AlertDialogDescription>
          Phòng <strong className="text-cream">{room?.name}</strong> và toàn bộ {room?.seatCount}{' '}
          ghế sẽ bị xóa vĩnh viễn. Chỉ xóa được phòng chưa từng có suất chiếu.
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
            onClick={() => room && mutation.mutate(room.id)}
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Xóa phòng
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AdminRoomsPage() {
  const { data, isPending, error, refetch } = useRooms();
  const [toDelete, setToDelete] = useState<AdminRoomSummary | null>(null);

  return (
    <AdminShell
      title="Phòng chiếu"
      description="Sơ đồ ghế của từng phòng. Mở một phòng để sửa loại ghế, ghế đôi và ghế tắt."
      actions={
        <Button asChild className="h-10 rounded-xl px-4 font-semibold">
          <Link to="/admin/rooms/new">
            <Plus aria-hidden />
            Thêm phòng
          </Link>
        </Button>
      }
    >
      {isPending ? (
        <div
          role="status"
          aria-label="Đang tải"
          className="h-48 animate-pulse rounded-2xl bg-white/5"
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState title="Chưa có phòng nào">
          <Link to="/admin/rooms/new" className="font-semibold text-brand hover:underline">
            Thêm phòng đầu tiên
          </Link>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Danh sách phòng chiếu</caption>
            <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Tên phòng
                </th>
                <th scope="col" className="px-4 py-3">
                  Kích thước
                </th>
                <th scope="col" className="px-4 py-3">
                  Số ghế
                </th>
                <th scope="col" className="px-4 py-3">
                  Đang bật
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.map((room) => (
                <tr key={room.id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-medium text-cream">{room.name}</td>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums">
                    {room.rows} hàng × {room.cols} cột
                  </td>
                  <td className="px-4 py-3 text-cream tabular-nums">{room.seatCount}</td>
                  <td className="px-4 py-3 text-cream tabular-nums">{room.activeSeatCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button asChild variant="ghost" size="sm" className="rounded-lg">
                        <Link to={`/admin/rooms/${room.id}`} aria-label={`Sửa ${room.name}`}>
                          <Pencil aria-hidden />
                          Sửa
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-lg text-destructive hover:text-destructive"
                        aria-label={`Xóa ${room.name}`}
                        onClick={() => setToDelete(room)}
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
      )}
      <DeleteRoomDialog room={toDelete} onClose={() => setToDelete(null)} />
    </AdminShell>
  );
}
