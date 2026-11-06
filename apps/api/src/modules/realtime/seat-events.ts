import { Injectable, Logger } from '@nestjs/common';
import {
  RealtimeEvent,
  type SeatHeldEvent,
  type SeatReleasedEvent,
  type SeatSoldEvent,
  showtimeRoom,
} from '@ticketify/shared';
import { RealtimeTransport, sendBestEffort } from './realtime-transport';

export type SeatEventName =
  | typeof RealtimeEvent.SEAT_HELD
  | typeof RealtimeEvent.SEAT_RELEASED
  | typeof RealtimeEvent.SEAT_SOLD;
export type SeatEventPayload = SeatHeldEvent | SeatReleasedEvent | SeatSoldEvent;

/**
 * Tells the browsers watching a showtime (room `showtime:{id}`) that some of its seats changed.
 * The transport decides how: the API sends through its Socket.IO server (Redis adapter), the
 * worker through the Redis emitter; both publish on the same channels.
 *
 * Call only AFTER the transaction that changed the seats has committed: a rolled-back change must
 * never be announced. Never throws: an event that cannot be sent is logged (`warn`) and dropped —
 * realtime is best-effort, `GET /showtimes/:id/seats` is the source of truth and clients reload it
 * when they reconnect or get a `409`.
 */
@Injectable()
export class SeatEvents {
  private readonly logger = new Logger(SeatEvents.name);

  constructor(private readonly transport: RealtimeTransport) {}

  /** After `POST /bookings` committed a new hold. */
  held(showtimeId: string, seatIds: readonly string[], heldUntil: Date): void {
    this.send(RealtimeEvent.SEAT_HELD, {
      showtimeId,
      seatIds: [...seatIds],
      heldUntil: heldUntil.toISOString(),
    });
  }

  /** After an expiry, a cancel or a booking sent to review gave seats back. */
  released(showtimeId: string, seatIds: readonly string[]): void {
    this.send(RealtimeEvent.SEAT_RELEASED, { showtimeId, seatIds: [...seatIds] });
  }

  /** After a payment confirmation committed (week 12). */
  sold(showtimeId: string, seatIds: readonly string[]): void {
    this.send(RealtimeEvent.SEAT_SOLD, { showtimeId, seatIds: [...seatIds] });
  }

  private send(event: SeatEventName, payload: SeatEventPayload): void {
    if (payload.seatIds.length === 0) return;
    sendBestEffort(
      this.transport,
      this.logger,
      showtimeRoom(payload.showtimeId),
      event,
      // The event name and the payload are chosen together by the methods above.
      payload as never,
    );
  }
}
