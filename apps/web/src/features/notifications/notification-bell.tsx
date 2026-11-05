import type { Notification } from '@ticketify/shared';
import { Bell, CheckCheck } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuthStore } from '@/features/auth/auth-store';
import { cn } from '@/lib/utils';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from './notifications-api';

/** `vài giây trước`, `12 phút trước`, `3 giờ trước`, then the date. */
function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1_000));
  if (Number.isNaN(seconds)) return '';
  if (seconds < 60) return 'vài giây trước';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return new Date(iso).toLocaleDateString('vi-VN');
}

/** `data.bookingId`, when the notification carries one. */
const bookingIdOf = (notification: Notification): string | undefined => {
  const id = notification.data?.bookingId;
  return typeof id === 'string' ? id : undefined;
};

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: Notification;
  onOpen: () => void;
}) {
  const markRead = useMarkNotificationRead();
  const bookingId = bookingIdOf(notification);
  const unread = notification.readAt === null;

  const read = () => {
    if (unread) markRead.mutate(notification.id);
  };

  const body = (
    <span className="flex items-start gap-2">
      <span
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', unread ? 'bg-brand' : 'bg-white/15')}
        aria-hidden
      />
      <span className="min-w-0">
        <span
          className={cn('block text-sm', unread ? 'font-semibold text-cream' : 'text-cream/80')}
        >
          {notification.title}
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{notification.body}</span>
        <span className="mt-1 block text-xs text-muted-foreground/70">
          {timeAgo(notification.createdAt)}
          {unread && <span className="sr-only"> (chưa đọc)</span>}
        </span>
      </span>
    </span>
  );

  const className = 'block w-full rounded-lg p-3 text-left transition-colors hover:bg-white/5';

  return (
    <li>
      {bookingId ? (
        <Link
          to={`/bookings/${bookingId}`}
          className={className}
          onClick={() => {
            read();
            onOpen();
          }}
        >
          {body}
        </Link>
      ) : (
        <button type="button" className={className} onClick={read}>
          {body}
        </button>
      )}
    </li>
  );
}

/**
 * Bell in the header (ROADMAP 4.3): the unread count, and the latest notifications in a popover.
 *
 * Only for a signed-in user, because notifications are personal. `unreadCount` comes from the
 * same response as the list, so the badge never disagrees with what the popover shows.
 */
export function NotificationBell() {
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const [open, setOpen] = useState(false);
  const { data, isPending, isError } = useNotifications(signedIn);
  const markAll = useMarkAllNotificationsRead();

  if (!signedIn) return null;

  const unread = data?.unreadCount ?? 0;
  const label = unread > 0 ? `Thông báo (${unread} chưa đọc)` : 'Thông báo';

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        aria-label={label}
        className="relative rounded-full p-2 text-cream transition-colors hover:text-brand"
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-brand px-1 text-[0.65rem] font-bold leading-4 text-black"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={10}
          className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-surface p-2 shadow-xl outline-none"
        >
          <div className="flex items-center justify-between px-2 py-1">
            <h2 className="text-sm font-semibold text-cream">Thông báo</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-cream disabled:opacity-50"
              >
                <CheckCheck className="size-3.5" aria-hidden />
                Đánh dấu đã đọc hết
              </button>
            )}
          </div>
          {isPending && <p className="p-3 text-sm text-muted-foreground">Đang tải…</p>}
          {isError && (
            <p className="p-3 text-sm text-muted-foreground">
              Không tải được thông báo. Vui lòng thử lại.
            </p>
          )}
          {data && data.items.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">Bạn chưa có thông báo nào.</p>
          )}
          {data && data.items.length > 0 && (
            <ul className="max-h-[60vh] overflow-y-auto">
              {data.items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onOpen={() => setOpen(false)}
                />
              ))}
            </ul>
          )}
          {data && data.total > data.items.length && (
            <p className="px-3 py-2 text-xs text-muted-foreground/70">
              Hiển thị {data.items.length} trong {data.total} thông báo.
            </p>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
