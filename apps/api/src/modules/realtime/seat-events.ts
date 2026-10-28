import { Logger } from '@nestjs/common';
import {
  RealtimeEvent,
  type SeatHeldEvent,
  type SeatReleasedEvent,
  type SeatSoldEvent,
  showtimeRoom,
} from '@ticketify/shared';

export type SeatEventName =
  | typeof RealtimeEvent.SEAT_HELD
  | typeof RealtimeEvent.SEAT_RELEASED
  | typeof RealtimeEvent.SEAT_SOLD;
export type SeatEventPayload = SeatHeldEvent | SeatReleasedEvent | SeatSoldEvent;

/**
 * Tells the browsers watching a showtime (room `showtime:{id}`) that some of its seats changed.
 * The API sends through its Socket.IO server (Redis adapter), the worker through the Redis
 * emitter; both publish on the same channels.
 *
 * Call only AFTER the transaction that changed the seats has committed: a rolled-back change must
 * never be announced. Never throws: an event that cannot be sent is logged (`warn`) and dropped —
 * realtime is best-effort, `GET /showtimes/:id/seats` is the source of truth and clients reload it
 * when they reconnect or get a `409`.
 */
export abstract class SeatEvents {
  protected readonly logger = new Logger(SeatEvents.name);

  /** After `POST /bookings` committed a new hold. */
  held(showtimeId: string, seatIds: readonly string[], heldUntil: Date): void {
    this.send(RealtimeEvent.SEAT_HELD, {
      showtimeId,
      seatIds: [...seatIds],
      heldUntil: heldUntil.toISOString(),
    });
  }

  /** After an expiry committed and gave seats back. */
  released(showtimeId: string, seatIds: readonly string[]): void {
    this.send(RealtimeEvent.SEAT_RELEASED, { showtimeId, seatIds: [...seatIds] });
  }

  /** After a payment confirmation committed (week 12). */
  sold(showtimeId: string, seatIds: readonly string[]): void {
    this.send(RealtimeEvent.SEAT_SOLD, { showtimeId, seatIds: [...seatIds] });
  }

  private send(event: SeatEventName, payload: SeatEventPayload): void {
    if (payload.seatIds.length === 0) return;
    try {
      this.emit(showtimeRoom(payload.showtimeId), event, payload);
    } catch (error) {
      this.logger.warn(
        `${event} not sent for showtime ${payload.showtimeId} (best-effort): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Sends one event to one room. May throw; `send` turns that into a warning. */
  protected abstract emit(room: string, event: SeatEventName, payload: SeatEventPayload): void;
}
