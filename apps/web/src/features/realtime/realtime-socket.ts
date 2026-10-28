import {
  AuthErrorCode,
  type ClientToServerEvents,
  handshakeErrorDataSchema,
  type ServerToClientEvents,
} from '@ticketify/shared';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '@/features/auth/auth-store';
import { env } from '@/lib/env';

export type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * A Socket.IO connection to the API, not yet connected (call `connect()`).
 *
 * - WebSocket only, like the server: no long-polling, so no sticky sessions behind several API
 *   instances.
 * - `auth` is a function, read again on every (re)connect: after `refreshSession()` the next
 *   attempt carries the new access token.
 */
export function createRealtimeSocket(): RealtimeSocket {
  return io(env.VITE_API_URL, {
    transports: ['websocket'],
    autoConnect: false,
    auth: (send) => send({ token: useAuthStore.getState().accessToken ?? '' }),
  });
}

const AUTH_CODES = new Set<string>([
  AuthErrorCode.UNAUTHORIZED,
  AuthErrorCode.TOKEN_EXPIRED,
  AuthErrorCode.TOKEN_INVALID,
]);

/**
 * The code of a handshake refused by the server (`UNAUTHORIZED`, `TOKEN_EXPIRED`,
 * `TOKEN_INVALID`), or `undefined` for a network error, which Socket.IO retries by itself.
 */
export function handshakeRefusalOf(error: Error): string | undefined {
  const parsed = handshakeErrorDataSchema.safeParse((error as Error & { data?: unknown }).data);
  return parsed.success && AUTH_CODES.has(parsed.data.code) ? parsed.data.code : undefined;
}
