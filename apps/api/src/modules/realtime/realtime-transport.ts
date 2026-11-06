import type { Logger } from '@nestjs/common';
import type { ServerToClientEvents } from '@ticketify/shared';

/** Payload of one server-to-client event, as the shared contract declares it. */
export type EventPayload<E extends keyof ServerToClientEvents> = Parameters<
  ServerToClientEvents[E]
>[0];

/**
 * How one process sends a realtime event to a room: the API through its Socket.IO server
 * (`GatewayTransport`), the worker through the Redis emitter (`EmitterTransport`). One per
 * process, shared by everything that publishes (seat events, notifications), so the worker opens
 * a single Redis connection for realtime.
 *
 * May throw: callers go through `sendBestEffort`.
 */
export abstract class RealtimeTransport {
  abstract emit<E extends keyof ServerToClientEvents>(
    room: string,
    event: E,
    payload: EventPayload<E>,
  ): void;
}

/**
 * Sends one event and swallows any failure as a warning.
 *
 * Realtime is best-effort by design: the HTTP API is the source of truth (the seat map, the
 * notification list), and clients reload it when they reconnect. An event that cannot be
 * published must never fail the request or the job that already committed its change — which is
 * also why every caller only sends AFTER its transaction committed.
 */
export function sendBestEffort<E extends keyof ServerToClientEvents>(
  transport: RealtimeTransport,
  logger: Logger,
  room: string,
  event: E,
  payload: EventPayload<E>,
): void {
  try {
    transport.emit(room, event, payload);
  } catch (error) {
    logger.warn(
      `${event} not sent to ${room} (best-effort): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
