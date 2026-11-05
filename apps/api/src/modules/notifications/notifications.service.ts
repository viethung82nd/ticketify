import { HttpStatus, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_LIMITS,
  type Notification,
  NotificationErrorCode,
  type NotificationPage,
  type NotificationType,
  type NotificationsRead,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import type { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { resolvePaging } from '../movies/paging';

const notificationNotFound = () =>
  apiException(
    HttpStatus.NOT_FOUND,
    NotificationErrorCode.NOTIFICATION_NOT_FOUND,
    'Notification not found',
  );

/** One notification to store, for one or more users, from one outbox event. */
export interface NewNotification {
  userIds: readonly string[];
  type: NotificationType;
  title: string;
  body: string;
  /** Ids the web app links on (`bookingId`, `bookingCode`, `showtimeId`, `paymentId`, `reason`). */
  data: Prisma.InputJsonObject;
  /** `outbox_events.id`, which makes storing it twice a no-op. */
  eventId: string;
}

/** A stored notification, with the user it belongs to (so the caller knows which room to push). */
export interface StoredNotification extends Notification {
  userId: string;
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: Prisma.JsonValue;
  read_at: Date | null;
  created_at: Date;
}

const toView = (row: NotificationRow): StoredNotification => ({
  id: row.id,
  userId: row.user_id,
  type: row.type,
  title: row.title,
  body: row.body,
  data: asData(row.data),
  readAt: row.read_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

const asData = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Notifications (ROADMAP 4.2): stored by the worker while it delivers an outbox event, read by
 * the owner through `GET /me/notifications`.
 *
 * Shared by both processes on purpose — the same rules decide what a notification looks like
 * wherever it is written — and holds no state of its own.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Stores one notification per user and returns only the rows this call created.
   *
   * `ON CONFLICT (user_id, event_id) DO NOTHING` against the partial unique index is what makes
   * the worker's at-least-once delivery safe: a second run of the same `notify` job inserts
   * nothing, returns nothing, and therefore pushes nothing. `gen_random_uuid()` rather than
   * Prisma's client-side default, because this has to be one statement to stay atomic.
   */
  async store(input: NewNotification): Promise<StoredNotification[]> {
    if (input.userIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<NotificationRow[]>`
      INSERT INTO notifications (id, user_id, type, title, body, data, event_id, created_at)
      SELECT gen_random_uuid(), recipient.user_id, ${input.type}, ${input.title}, ${input.body},
             ${input.data}::jsonb, ${input.eventId}::uuid, ${this.clock.now()}
      FROM unnest(${[...input.userIds]}::uuid[]) AS recipient(user_id)
      ON CONFLICT (user_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
      RETURNING id, user_id, type, title, body, data, read_at, created_at`;
    return rows.map(toView);
  }

  /** The user's notifications, newest first, optionally only the unread ones. */
  async listOfUser(
    userId: string,
    query: { unread?: boolean; page?: number; pageSize?: number },
  ): Promise<NotificationPage> {
    const paging = resolvePaging(query, NOTIFICATION_LIMITS.listPageSizeDefault);
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unread ? { readAt: null } : {}),
    };
    const [total, unreadCount, rows] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: paging.skip,
        take: paging.pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        data: asData(row.data),
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page: paging.page,
      pageSize: paging.pageSize,
      unreadCount,
    };
  }

  /**
   * Marks one notification read and returns it. Already read: returned unchanged (the same
   * answer, so a double click is harmless). Unknown, or another user's: `404`, never `403`.
   */
  async markRead(userId: string, id: string): Promise<Notification> {
    const [updated] = await this.prisma.$queryRaw<NotificationRow[]>`
      UPDATE notifications SET read_at = ${this.clock.now()}
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL
      RETURNING id, user_id, type, title, body, data, read_at, created_at`;
    if (updated) return strip(toView(updated));

    const row = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!row) throw notificationNotFound();
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      data: asData(row.data),
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Marks every unread notification of the user read; `updated` is how many changed. */
  async markAllRead(userId: string): Promise<NotificationsRead> {
    const updated = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return { updated: updated.count };
  }

  /** Every admin's id, for the notifications only an admin should see (ROADMAP 4.2). */
  async adminIds(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return admins.map((admin) => admin.id);
  }
}

/** The owner is implied by the token, so a response never repeats the user id. */
const strip = ({ userId: _userId, ...notification }: StoredNotification): Notification =>
  notification;
