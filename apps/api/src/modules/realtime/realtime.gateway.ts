import { HttpException, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  AuthErrorCode,
  type ClientToServerEvents,
  type HandshakeErrorData,
  type JoinShowtimeAck,
  type LeaveShowtimeAck,
  REALTIME_LIMITS,
  RealtimeErrorCode,
  RealtimeEvent,
  type RealtimeError,
  type ServerToClientEvents,
  ShowtimeErrorCode,
  ShowtimeStatus,
  showtimeRoom,
  showtimeSubscriptionSchema,
} from '@ticketify/shared';
import type { ExtendedError, Server, Socket } from 'socket.io';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AccessTokenVerifier } from '../auth/tokens/access-token.verifier';

export interface RealtimeSocketData {
  user: AuthUser;
  /** Showtimes this socket joined or is joining right now (at most `subscriptionsMax`). */
  showtimes: Set<string>;
}

// Inter-server events are unused (no serverSideEmit): `never` keys.
export type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  RealtimeSocketData
>;

export const joinRateKey = (userId: string): string => `rl:ws-join:user:${userId}`;

/** `connect_error` for a refused handshake: `message` is the code, `data` repeats it. */
export function handshakeError(code: string, message: string): ExtendedError {
  const data: HandshakeErrorData = { code, message };
  return Object.assign(new Error(code), { data });
}

/** Code and message of an `apiException` (the verifier throws `TOKEN_EXPIRED` / `TOKEN_INVALID`). */
function apiErrorParts(error: unknown): { code: string; message: string } {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && 'code' in body && typeof body.code === 'string') {
      const message = 'message' in body && typeof body.message === 'string' ? body.message : '';
      return { code: body.code, message };
    }
  }
  return { code: AuthErrorCode.TOKEN_INVALID, message: 'Access token is invalid' };
}

const failure = (
  event: string,
  code: string,
  message: string,
  details?: unknown,
): RealtimeError => ({ event, code, message, ...(details === undefined ? {} : { details }) });

/**
 * Socket.IO gateway on the API's own HTTP server (path `/socket.io`, root namespace), PLAN §8.
 *
 * - Handshake: `auth.token` is an access token, checked by the same verifier as the HTTP guard.
 *   No token → `UNAUTHORIZED`, expired → `TOKEN_EXPIRED` (refresh, then connect again), anything
 *   else → `TOKEN_INVALID`. Guests get no socket: only signed-in users book (PLAN §1).
 *   The token is checked once, at the handshake; the room events carry no personal data.
 * - `showtime:join` / `showtime:leave` put the socket in room `showtime:{id}`, where seat events
 *   are sent (`SeatEvents`). Every failure answers in the ack AND as an `error` event.
 *
 * CORS, the transport and the Redis adapter are set by `RealtimeIoAdapter` (main.ts).
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly verifier: AccessTokenVerifier,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => next(this.authenticate(socket as RealtimeSocket)));
  }

  /** Handshake check; `undefined` lets the socket in with `data.user` set. */
  authenticate(socket: RealtimeSocket): ExtendedError | undefined {
    const auth: Record<string, unknown> = socket.handshake.auth;
    const token = auth.token;
    if (typeof token !== 'string' || token === '') {
      return handshakeError(AuthErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    try {
      socket.data.user = this.verifier.verify(token);
    } catch (error) {
      const { code, message } = apiErrorParts(error);
      return handshakeError(code, message);
    }
    socket.data.showtimes = new Set();
    return undefined;
  }

  @SubscribeMessage(RealtimeEvent.SHOWTIME_JOIN)
  async join(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<JoinShowtimeAck> {
    let ack: JoinShowtimeAck;
    try {
      ack = await this.joinShowtime(socket, body);
    } catch (error) {
      this.logger.error(
        `showtime:join failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      ack = {
        joined: false,
        error: failure(RealtimeEvent.SHOWTIME_JOIN, 'INTERNAL_ERROR', 'Could not join, retry'),
      };
    }
    if (!ack.joined) socket.emit(RealtimeEvent.ERROR, ack.error);
    return ack;
  }

  @SubscribeMessage(RealtimeEvent.SHOWTIME_LEAVE)
  async leave(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<LeaveShowtimeAck> {
    const parsed = showtimeSubscriptionSchema.safeParse(body);
    if (!parsed.success) {
      const error = invalidShowtimeId(RealtimeEvent.SHOWTIME_LEAVE);
      socket.emit(RealtimeEvent.ERROR, error);
      return { left: false, error };
    }
    const { showtimeId } = parsed.data;
    await socket.leave(showtimeRoom(showtimeId));
    socket.data.showtimes.delete(showtimeId);
    return { left: true };
  }

  private async joinShowtime(socket: RealtimeSocket, body: unknown): Promise<JoinShowtimeAck> {
    const event = RealtimeEvent.SHOWTIME_JOIN;
    const parsed = showtimeSubscriptionSchema.safeParse(body);
    if (!parsed.success) return { joined: false, error: invalidShowtimeId(event) };
    const { showtimeId } = parsed.data;
    const { user, showtimes } = socket.data;

    // Counted before any database work, like the booking limit. Fail-open if Redis is down.
    const limit = await this.rateLimit.hit(
      joinRateKey(user.id),
      REALTIME_LIMITS.joinsMax,
      REALTIME_LIMITS.joinWindowSeconds,
    );
    if (!limit.allowed) {
      return {
        joined: false,
        error: failure(event, RealtimeErrorCode.TOO_MANY_ATTEMPTS, 'Too many joins, slow down', {
          retryAfterSeconds: limit.retryAfterSeconds,
        }),
      };
    }

    const room = showtimeRoom(showtimeId);
    if (socket.rooms.has(room)) return { joined: true };
    // Reserved synchronously (before the query below), so concurrent joins on one socket cannot
    // all pass the check and end up above the limit.
    if (!showtimes.has(showtimeId) && showtimes.size >= REALTIME_LIMITS.subscriptionsMax) {
      return {
        joined: false,
        error: failure(
          event,
          RealtimeErrorCode.TOO_MANY_SUBSCRIPTIONS,
          `A connection may watch at most ${REALTIME_LIMITS.subscriptionsMax} showtimes; leave one first`,
          { max: REALTIME_LIMITS.subscriptionsMax },
        ),
      };
    }
    showtimes.add(showtimeId);

    try {
      const showtime = await this.prisma.showtime.findUnique({
        where: { id: showtimeId },
        select: { status: true },
      });
      // Same answer as the public seat map: a cancelled showtime is "not found".
      if (!showtime || showtime.status === ShowtimeStatus.CANCELLED) {
        showtimes.delete(showtimeId);
        return {
          joined: false,
          error: failure(event, ShowtimeErrorCode.SHOWTIME_NOT_FOUND, 'Showtime not found'),
        };
      }
      await socket.join(room);
      return { joined: true };
    } catch (error) {
      if (!socket.rooms.has(room)) showtimes.delete(showtimeId);
      throw error;
    }
  }
}

const invalidShowtimeId = (event: string): RealtimeError =>
  failure(event, 'VALIDATION_FAILED', 'Request validation failed', [
    { field: 'showtimeId', messages: ['showtimeId must be a UUID'] },
  ]);
