import { Injectable, Logger } from '@nestjs/common';
import { type Notification, RealtimeEvent, userRoom } from '@ticketify/shared';
import { RealtimeTransport, sendBestEffort } from './realtime-transport';

/**
 * Pushes a stored notification to its owner's sockets (room `user:{id}`, which every socket of
 * that user joins at the handshake). Nothing else is ever sent to that room, so no client sees
 * another user's notification.
 *
 * Call only AFTER the `Notification` row committed, and only for rows the insert really created:
 * the row is the source of truth (`GET /me/notifications`), this is the nudge that saves the
 * client a poll. Never throws (best-effort, like `SeatEvents`).
 */
@Injectable()
export class NotificationEvents {
  private readonly logger = new Logger(NotificationEvents.name);

  constructor(private readonly transport: RealtimeTransport) {}

  created(userId: string, notification: Notification): void {
    sendBestEffort(
      this.transport,
      this.logger,
      userRoom(userId),
      RealtimeEvent.NOTIFICATION_NEW,
      notification,
    );
  }
}
