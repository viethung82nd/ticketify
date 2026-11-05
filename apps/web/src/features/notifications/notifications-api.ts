import {
  type Notification,
  NOTIFICATION_LIMITS,
  type NotificationPage,
  notificationPageSchema,
  notificationSchema,
  notificationsReadSchema,
} from '@ticketify/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

/** `GET /me/notifications`. Newest first; `unreadCount` covers the whole list, not this page. */
export async function getNotifications(params: {
  page?: number;
  pageSize?: number;
  unread?: boolean;
}): Promise<NotificationPage> {
  const res = await apiClient.get<unknown>('/me/notifications', {
    params: {
      page: params.page,
      pageSize: params.pageSize,
      ...(params.unread ? { unread: true } : {}),
    },
  });
  return notificationPageSchema.parse(res.data);
}

/** `POST /me/notifications/:id/read`. Marking an already read one again is harmless. */
export async function markNotificationRead(id: string): Promise<Notification> {
  const res = await apiClient.post<unknown>(`/me/notifications/${id}/read`);
  return notificationSchema.parse(res.data);
}

/** `POST /me/notifications/read`: every unread one of the signed-in user. */
export async function markAllNotificationsRead(): Promise<{ updated: number }> {
  const res = await apiClient.post<unknown>('/me/notifications/read');
  return notificationsReadSchema.parse(res.data);
}

export const notificationKeys = {
  all: ['notifications'] as const,
  page: (page: number) => ['notifications', 'page', page] as const,
};

/**
 * The first page of notifications, which is what the bell shows. Enabled only while signed in;
 * the socket (`useNotificationStream`) refreshes it when something arrives, so it is not polled.
 */
export const useNotifications = (enabled: boolean, page = 1) =>
  useQuery({
    queryKey: notificationKeys.page(page),
    queryFn: () => getNotifications({ page, pageSize: NOTIFICATION_LIMITS.listPageSizeDefault }),
    enabled,
    staleTime: 30_000,
  });

/** Marks one read, then reloads the list so `unreadCount` and the bell agree with the server. */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
