import { z } from 'zod';

/**
 * Socket.IO contract between the API (gateway + worker emitter) and the web (PLAN §8).
 *
 * Realtime is a hint, never the source of truth: a client applies these events to the seat map it
 * already has, and reloads `GET /showtimes/:id/seats` whenever it (re)connects, gets a `409` from
 * `POST /bookings`, or receives an event that does not match what it knows.
 */

/** Event names, both directions. */
export const RealtimeEvent = {
  /** Client → server, with an ack: `{ showtimeId }` → `JoinShowtimeAck`. */
  SHOWTIME_JOIN: 'showtime:join',
  /** Client → server, with an ack: `{ showtimeId }` → `LeaveShowtimeAck`. */
  SHOWTIME_LEAVE: 'showtime:leave',
  /** Server → room `showtime:{id}`: seats held by a booking that has just committed. */
  SEAT_HELD: 'seat:held',
  /** Server (worker) → room: seats an expired booking gave back. */
  SEAT_RELEASED: 'seat:released',
  /** Server → room: seats sold (declared now, emitted from week 12). */
  SEAT_SOLD: 'seat:sold',
  /** Server → the one socket whose request failed (also sent in the ack). */
  ERROR: 'error',
} as const;
export type RealtimeEvent = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

/** Room of one showtime. The worker's emitter and the gateway must agree on it. */
export const showtimeRoom = (showtimeId: string): string => `showtime:${showtimeId}`;

export const REALTIME_LIMITS = {
  /** Showtime rooms one socket may be in at once. */
  subscriptionsMax: 5,
  /** `showtime:join` per user per window (RateLimitService, fixed window). */
  joinsMax: 30,
  joinWindowSeconds: 60,
} as const;

// ─── Client → server ───

export const showtimeSubscriptionSchema = z.object({ showtimeId: z.uuid() });
export type ShowtimeSubscription = z.infer<typeof showtimeSubscriptionSchema>;

// ─── Server → client ───

/**
 * Only the seats that changed, never the whole map, and nothing about who changed them (no user
 * id): every client in the room receives the same payload.
 */
export const seatHeldEventSchema = z.object({
  showtimeId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1),
  /** ISO instant the seats are held until (the booking's `holdUntil`). */
  heldUntil: z.string(),
});
export type SeatHeldEvent = z.infer<typeof seatHeldEventSchema>;

export const seatReleasedEventSchema = z.object({
  showtimeId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1),
});
export type SeatReleasedEvent = z.infer<typeof seatReleasedEventSchema>;

export const seatSoldEventSchema = seatReleasedEventSchema;
export type SeatSoldEvent = z.infer<typeof seatSoldEventSchema>;

/**
 * Machine-readable codes of realtime errors (besides the shared auth and validation ones). The two
 * limits of `showtime:join` have distinct codes: how many rooms at once is not how often.
 */
export const RealtimeErrorCode = {
  /** `showtime:join` beyond `REALTIME_LIMITS.subscriptionsMax` rooms on one socket. */
  TOO_MANY_SUBSCRIPTIONS: 'TOO_MANY_SUBSCRIPTIONS',
  /**
   * `showtime:join` more than `REALTIME_LIMITS.joinsMax` times per user per window;
   * `details.retryAfterSeconds`. Same code as the login and booking rate limits.
   */
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
} as const;
export type RealtimeErrorCode = (typeof RealtimeErrorCode)[keyof typeof RealtimeErrorCode];

/**
 * `error` event and the `error` of a failed ack. Codes: `VALIDATION_FAILED`, `SHOWTIME_NOT_FOUND`
 * (unknown or cancelled showtime), `TOO_MANY_SUBSCRIPTIONS` (rooms per socket),
 * `TOO_MANY_ATTEMPTS` (join rate, `details.retryAfterSeconds`), `INTERNAL_ERROR`.
 */
export const realtimeErrorSchema = z.object({
  /** Client event that failed. */
  event: z.string(),
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type RealtimeError = z.infer<typeof realtimeErrorSchema>;

export const joinShowtimeAckSchema = z.union([
  z.object({ joined: z.literal(true) }),
  z.object({ joined: z.literal(false), error: realtimeErrorSchema }),
]);
export type JoinShowtimeAck = z.infer<typeof joinShowtimeAckSchema>;

export const leaveShowtimeAckSchema = z.union([
  z.object({ left: z.literal(true) }),
  z.object({ left: z.literal(false), error: realtimeErrorSchema }),
]);
export type LeaveShowtimeAck = z.infer<typeof leaveShowtimeAckSchema>;

/**
 * Handshake refusal (`connect_error`): `message` is the code — `UNAUTHORIZED` (no token),
 * `TOKEN_EXPIRED` (refresh, then connect again) or `TOKEN_INVALID` — and `data` repeats it.
 */
export const handshakeErrorDataSchema = z.object({ code: z.string(), message: z.string() });
export type HandshakeErrorData = z.infer<typeof handshakeErrorDataSchema>;

/** Typed maps for `socket.io` / `socket.io-client` generics. */
export interface ServerToClientEvents {
  'seat:held': (payload: SeatHeldEvent) => void;
  'seat:released': (payload: SeatReleasedEvent) => void;
  'seat:sold': (payload: SeatSoldEvent) => void;
  error: (payload: RealtimeError) => void;
}

export interface ClientToServerEvents {
  'showtime:join': (payload: ShowtimeSubscription, ack: (reply: JoinShowtimeAck) => void) => void;
  'showtime:leave': (payload: ShowtimeSubscription, ack: (reply: LeaveShowtimeAck) => void) => void;
}
