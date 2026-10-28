import {
  type AdminRoom,
  type RenameRoomRequest,
  renameRoomRequestSchema,
  ROOM_LIMITS,
  RoomErrorCode,
} from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Loader2, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { AdminShell } from '@/components/admin/admin-shell';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { catalogErrorMessage, errorCodeOf } from '@/features/catalog/catalog-errors';
import { renameRoom } from '@/features/rooms/rooms-api';
import { SeatGridEditor } from '@/features/rooms/seat-grid-editor';
import { roomKeys, useRoom } from '@/features/rooms/use-rooms';

/** Times are shown on the cinema's clock, whatever the admin's device zone is. */
const cinemaTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * Stable number per seats array. TanStack Query keeps the same array when refetched data is
 * unchanged, so the editor remounts (dropping its draft) only when the seats really changed.
 */
const seatVersions = new WeakMap<object, number>();
let lastSeatVersion = 0;
function versionOf(seats: object): number {
  let version = seatVersions.get(seats);
  if (version === undefined) {
    lastSeatVersion += 1;
    version = lastSeatVersion;
    seatVersions.set(seats, version);
  }
  return version;
}

function RenameForm({ room }: { room: AdminRoom }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(room.name);
  const mutation = useMutation({
    mutationFn: (body: RenameRoomRequest) => renameRoom(room.id, body),
    onSuccess: async (saved) => {
      // Keep the seat editor's draft: only the name changed.
      queryClient.setQueryData<AdminRoom>(roomKeys.detail(room.id), (old) =>
        old ? { ...old, name: saved.name } : saved,
      );
      await queryClient.invalidateQueries({ queryKey: roomKeys.list });
    },
  });
  const parsed = renameRoomRequestSchema.safeParse({ name });
  const localError = parsed.success ? undefined : parsed.error.issues[0]?.message;
  const serverError = mutation.error
    ? errorCodeOf(mutation.error) === RoomErrorCode.ROOM_NAME_TAKEN
      ? 'Tên phòng này đã được dùng.'
      : catalogErrorMessage(mutation.error)
    : undefined;
  const error = localError ?? serverError;
  const unchanged = parsed.success && parsed.data.name === room.name;

  return (
    <form
      className="flex max-w-lg flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.success && !unchanged) mutation.mutate(parsed.data);
      }}
    >
      <div className="min-w-56 flex-1 space-y-1.5">
        <label htmlFor="room-name" className="block text-sm font-medium text-cream">
          Tên phòng
        </label>
        <Input
          id="room-name"
          value={name}
          maxLength={ROOM_LIMITS.nameMax}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'room-name-error' : undefined}
          onChange={(e) => {
            setName(e.target.value);
            mutation.reset();
          }}
        />
        {error && (
          <p id="room-name-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {mutation.isSuccess && !error && unchanged && (
          <p className="text-sm text-muted-foreground" role="status">
            Đã đổi tên.
          </p>
        )}
      </div>
      <Button
        type="submit"
        variant="outline"
        disabled={!parsed.success || unchanged || mutation.isPending}
        className="mt-7 h-11 rounded-xl px-4"
      >
        {mutation.isPending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <Check aria-hidden />
        )}
        Đổi tên
      </Button>
    </form>
  );
}

export function RoomEditorPage() {
  const { id = '' } = useParams();
  const { data: room, error, refetch } = useRoom(id);

  if (!room && !error) {
    return (
      <AdminShell title="Sơ đồ ghế">
        <div
          role="status"
          aria-label="Đang tải"
          className="h-96 animate-pulse rounded-2xl bg-white/5"
        />
      </AdminShell>
    );
  }
  if (!room) {
    return (
      <AdminShell title="Sơ đồ ghế">
        {errorCodeOf(error) === RoomErrorCode.ROOM_NOT_FOUND ? (
          <EmptyState title="Không tìm thấy phòng">
            <Link to="/admin/rooms" className="font-semibold text-brand hover:underline">
              Về danh sách phòng
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={() => void refetch()} />
        )}
      </AdminShell>
    );
  }

  const active = room.seats.filter((seat) => seat.isActive).length;
  return (
    <AdminShell
      title={room.name}
      description={`${room.rows} hàng × ${room.cols} cột · ${room.seats.length} ghế · ${active} ghế đang bật`}
      actions={
        <Button asChild variant="ghost" className="h-10 rounded-xl">
          <Link to="/admin/rooms">
            <ArrowLeft aria-hidden />
            Danh sách phòng
          </Link>
        </Button>
      }
    >
      <div className="space-y-6 pb-10">
        <RenameForm room={room} />
        {room.lock && (
          <div
            role="status"
            className="flex gap-3 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm text-cream"
          >
            <Lock className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            <p>
              <strong>Sơ đồ ghế đang bị khóa.</strong> Phòng có {room.lock.activeShowtimeCount} suất
              chiếu chưa kết thúc; suất cuối kết thúc lúc{' '}
              <strong>{cinemaTime.format(new Date(room.lock.until))}</strong>. Giá và trạng thái ghế
              đã được chốt cho từng suất, nên chỉ sửa được sơ đồ sau thời điểm đó. Bạn vẫn có thể
              đổi tên phòng.
            </p>
          </div>
        )}
        {/* New seats (after a save) start a fresh draft; a rename or lock change keeps it. */}
        <SeatGridEditor key={versionOf(room.seats)} room={room} locked={room.lock !== null} />
      </div>
    </AdminShell>
  );
}
