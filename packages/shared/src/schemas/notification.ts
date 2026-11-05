import { z } from 'zod';
import { pageSchema } from './movie.js';

/**
 * In-app notifications (PLAN §7, ROADMAP 4.2). Written by the worker when it delivers an outbox
 * event, then pushed to the owner's sockets (room `user:{id}`) and listed by `GET
 * /me/notifications`.
 */

/** What a notification is about. Stored as text, so an older client simply shows the fallback. */
export const NotificationType = {
  /** The booking is paid and its tickets are issued. To the user who booked. */
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  /** Paid, but the seats could not be kept. To the user, and to every admin. */
  BOOKING_NEEDS_REVIEW: 'BOOKING_NEEDS_REVIEW',
  /** One booking was paid twice: the second payment must be refunded by hand. Admins only. */
  PAYMENT_REFUND_REQUIRED: 'PAYMENT_REFUND_REQUIRED',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const NOTIFICATION_LIMITS = {
  listPageSizeDefault: 20,
  listPageSizeMax: 50,
} as const;

/**
 * `data` carries the ids the web app needs to link somewhere (`bookingId`, `bookingCode`,
 * `showtimeId`, `paymentId`, `reason`); it is never the source of truth for anything.
 */
export const notificationSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  /** ISO instant the owner read it, or `null` while unread. */
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

/** `unreadCount` counts every unread notification of the user, not only those on this page. */
export const notificationPageSchema = pageSchema(notificationSchema).extend({
  unreadCount: z.number().int(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

/** What `POST /me/notifications/read` answers: how many went from unread to read. */
export const notificationsReadSchema = z.object({ updated: z.number().int() });
export type NotificationsRead = z.infer<typeof notificationsReadSchema>;

export const NotificationErrorCode = {
  /** No such notification, or it belongs to another user (never a 403). */
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
} as const;
export type NotificationErrorCode =
  (typeof NotificationErrorCode)[keyof typeof NotificationErrorCode];
