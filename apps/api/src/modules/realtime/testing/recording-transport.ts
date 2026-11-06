import type { ServerToClientEvents } from '@ticketify/shared';
import { type EventPayload, RealtimeTransport } from '../realtime-transport';

/** One event a test transport was asked to send. */
export interface SentEvent {
  room: string;
  event: keyof ServerToClientEvents;
  payload: unknown;
}

/**
 * `RealtimeTransport` for tests: records what would have been published, and can be made to fail
 * to check that publishers stay best-effort.
 */
export class RecordingTransport extends RealtimeTransport {
  readonly sent: SentEvent[] = [];
  failWith: Error | null = null;

  emit<E extends keyof ServerToClientEvents>(
    room: string,
    event: E,
    payload: EventPayload<E>,
  ): void {
    if (this.failWith) throw this.failWith;
    this.sent.push({ room, event, payload });
  }

  /** `[room, event, payload]` triples, the shape assertions read most easily. */
  triples(): [string, string, unknown][] {
    return this.sent.map((entry) => [entry.room, entry.event, entry.payload]);
  }

  clear(): void {
    this.sent.length = 0;
  }
}
