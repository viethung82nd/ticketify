import { type Notification, NotificationType, notificationSchema } from '@ticketify/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast, type ToastTone } from '@/components/ui/toast-store';
import { useAuthStore } from '@/features/auth/auth-store';
import { refreshSession } from '@/features/auth/session';
import { createRealtimeSocket, handshakeRefusalOf } from '@/features/realtime/realtime-socket';
import { bookingKeys } from '@/features/bookings/bookings-api';
import { notificationKeys } from './notifications-api';

/** Which notifications are worth interrupting the reader for, and in what tone. */
const TOASTED: Partial<Record<string, ToastTone>> = {
  [NotificationType.BOOKING_CONFIRMED]: 'success',
  [NotificationType.BOOKING_NEEDS_REVIEW]: 'warning',
  [NotificationType.PAYMENT_REFUND_REQUIRED]: 'warning',
};

/** `data.bookingId`, when the notification carries one. */
const bookingIdOf = (notification: Notification): string | undefined => {
  const id = notification.data?.bookingId;
  return typeof id === 'string' ? id : undefined;
};

/**
 * One socket for the signed-in user's own notifications (ROADMAP 4.3).
 *
 * The server puts every socket in room `user:{id}` at the handshake, so this listens and does not
 * join anything. An arriving `notification:new` refreshes the list (the HTTP list stays the source
 * of truth, as with the seat map) and raises a toast for the kinds worth interrupting for. A
 * booking the notification is about is refreshed too, so an open booking page shows CONFIRMED
 * without waiting for its 30-second poll.
 *
 * Mounted once, in the app layout. Reconnects are left to Socket.IO; a refused handshake is
 * retried once after refreshing the access token, and then given up on — notifications are a
 * convenience, and the list is one click away.
 */
export function useNotificationStream(): void {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id);

  useEffect(() => {
    if (!userId) return;
    const socket = createRealtimeSocket();
    let disposed = false;
    let refreshedForAuth = false;

    socket.on('connect', () => {
      refreshedForAuth = false;
      // Anything that arrived while disconnected is in the list, not in the socket.
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    });

    socket.on('notification:new', (payload: unknown) => {
      const parsed = notificationSchema.safeParse(payload);
      if (!parsed.success) {
        void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
        return;
      }
      const notification = parsed.data;
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      const bookingId = bookingIdOf(notification);
      if (bookingId) {
        void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(bookingId) });
      }
      const tone = TOASTED[notification.type];
      if (!tone) return;
      toast({
        // The notification id, so the same one arriving twice replaces its toast.
        id: `notification-${notification.id}`,
        tone,
        title: notification.title,
        description: notification.body,
        to: bookingId ? `/bookings/${bookingId}` : undefined,
      });
    });

    socket.on('connect_error', (error) => {
      if (disposed) return;
      // No refusal code: a network error, which Socket.IO retries on its own.
      if (!handshakeRefusalOf(error)) return;
      if (refreshedForAuth) {
        // Refused twice in a row: the session really is over, so stop retrying.
        socket.disconnect();
        return;
      }
      refreshedForAuth = true;
      refreshSession()
        .then(() => {
          if (!disposed) socket.connect();
        })
        .catch(() => undefined);
    });

    socket.connect();
    return () => {
      disposed = true;
      socket.disconnect();
    };
  }, [userId, queryClient]);
}
