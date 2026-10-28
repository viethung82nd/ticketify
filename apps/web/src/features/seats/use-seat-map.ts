import {
  joinShowtimeAckSchema,
  PublicSeatStatus,
  RealtimeEvent,
  seatHeldEventSchema,
  seatReleasedEventSchema,
  seatSoldEventSchema,
  type ShowtimeSeatMap,
} from '@ticketify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { refreshSession } from '@/features/auth/session';
import { createRealtimeSocket, handshakeRefusalOf } from '@/features/realtime/realtime-socket';
import { getSeatMap, seatMapKeys } from './seat-map-api';
import { applySeatEvent, type SeatEventStatus } from './seat-selection';

/**
 * - `connecting`: first connection; `reconnecting`: the connection dropped, Socket.IO retries.
 * - `syncing`: (re)joined the room, reloading the map so nothing missed while away stays shown.
 * - `live`: joined and in sync — the only phase in which booking is allowed.
 * - `failed`: will not recover alone (session over, showtime gone); `message` says why.
 */
export type LivePhase = 'connecting' | 'reconnecting' | 'syncing' | 'live' | 'failed';

export interface LiveState {
  phase: LivePhase;
  message?: string;
}

const isClientError = (error: unknown): boolean => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return status !== undefined && status >= 400 && status < 500;
};

/** Longest the client waits for the join ack before treating the connection as broken. */
const JOIN_TIMEOUT_MS = 10_000;

const JOIN_FAILURES: Record<string, string> = {
  SHOWTIME_NOT_FOUND: 'Suất chiếu không còn tồn tại hoặc đã bị hủy.',
  TOO_MANY_ATTEMPTS: 'Bạn mở sơ đồ ghế quá nhiều lần trong một phút. Vui lòng thử lại sau.',
  TOO_MANY_SUBSCRIPTIONS:
    'Bạn đang xem quá nhiều suất chiếu cùng lúc. Hãy đóng bớt các tab đang mở sơ đồ ghế rồi tải lại trang.',
};

/**
 * Seat map of one showtime, kept up to date in realtime (ROADMAP 2.12).
 *
 * `GET /showtimes/:id/seats` (TanStack Query) is the source of truth. The socket only patches the
 * cached copy with `seat:held` / `seat:released` / `seat:sold` for the seats each event lists.
 * The whole map is reloaded when the room is (re)joined — events sent while disconnected are
 * lost — and when an event does not fit what the map shows (`applySeatEvent` mismatch).
 *
 * `onSeatsTaken` gets the ids of seats another customer has just held or bought, so the page can
 * drop them from the selection.
 */
export function useSeatMap(showtimeId: string, onSeatsTaken: (seatIds: string[]) => void) {
  const queryClient = useQueryClient();
  const queryKey = seatMapKeys.showtime(showtimeId);
  const query = useQuery({
    queryKey,
    queryFn: () => getSeatMap(showtimeId),
    // A 404 (unknown or cancelled showtime) will not change on retry.
    retry: (count, error) => count < 1 && !isClientError(error),
  });
  const [live, setLive] = useState<LiveState>({ phase: 'connecting' });
  const onTaken = useRef(onSeatsTaken);
  useEffect(() => {
    onTaken.current = onSeatsTaken;
  }, [onSeatsTaken]);

  useEffect(() => {
    const key = seatMapKeys.showtime(showtimeId);
    const socket = createRealtimeSocket();
    let disposed = false;
    let connectedOnce = false;
    /** One refresh per refused handshake; a second refusal in a row means the session is over. */
    let refreshedForAuth = false;

    const reload = () => queryClient.refetchQueries({ queryKey: key, exact: true });

    function apply<T extends { showtimeId: string; seatIds: string[] }>(
      schema: z.ZodType<T>,
      status: SeatEventStatus,
      payload: unknown,
    ) {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        void reload();
        return;
      }
      if (parsed.data.showtimeId !== showtimeId) return;
      let mismatch = false;
      queryClient.setQueryData<ShowtimeSeatMap>(key, (map) => {
        if (!map) return map;
        const result = applySeatEvent(map, parsed.data.seatIds, status);
        mismatch = result.mismatch;
        return result.map;
      });
      if (mismatch) void reload();
      if (status !== PublicSeatStatus.AVAILABLE) onTaken.current(parsed.data.seatIds);
    }

    socket.on('connect', () => {
      connectedOnce = true;
      refreshedForAuth = false;
      setLive({ phase: 'syncing' });
      socket
        .timeout(JOIN_TIMEOUT_MS)
        .emitWithAck(RealtimeEvent.SHOWTIME_JOIN, { showtimeId })
        .then(async (reply: unknown) => {
          if (disposed) return;
          const ack = joinShowtimeAckSchema.safeParse(reply);
          if (!ack.success || !ack.data.joined) {
            const code = ack.success && !ack.data.joined ? ack.data.error.code : '';
            setLive({
              phase: 'failed',
              message: JOIN_FAILURES[code] ?? 'Không theo dõi được sơ đồ ghế.',
            });
            return;
          }
          // Joined first, reloaded second: an event sent in between is applied on top of an
          // older copy at worst, never lost.
          await reload();
          if (!disposed && socket.connected) setLive({ phase: 'live' });
        })
        .catch(() => {
          // No ack in time: drop the connection and let the reconnect path start over.
          if (!disposed) socket.disconnect().connect();
        });
    });

    socket.on('disconnect', (reason) => {
      if (disposed) return;
      setLive({ phase: 'reconnecting' });
      // A server-side disconnect is not retried by Socket.IO; every other reason is.
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (error) => {
      if (disposed) return;
      const refusal = handshakeRefusalOf(error);
      if (!refusal) {
        // Network or server down: Socket.IO keeps retrying with backoff.
        setLive({ phase: connectedOnce ? 'reconnecting' : 'connecting' });
        return;
      }
      if (refreshedForAuth) {
        setLive({ phase: 'failed', message: 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.' });
        return;
      }
      // Expired (or missing) access token: refresh it, then connect again with the new one.
      refreshedForAuth = true;
      refreshSession()
        .then(() => {
          if (!disposed) socket.connect();
        })
        .catch(() => {
          if (!disposed) {
            setLive({
              phase: 'failed',
              message: 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.',
            });
          }
        });
    });

    socket.on(RealtimeEvent.SEAT_HELD, (payload) =>
      apply(seatHeldEventSchema, PublicSeatStatus.HELD, payload),
    );
    socket.on(RealtimeEvent.SEAT_RELEASED, (payload) =>
      apply(seatReleasedEventSchema, PublicSeatStatus.AVAILABLE, payload),
    );
    socket.on(RealtimeEvent.SEAT_SOLD, (payload) =>
      apply(seatSoldEventSchema, PublicSeatStatus.SOLD, payload),
    );

    socket.connect();
    return () => {
      disposed = true;
      socket.disconnect();
    };
  }, [showtimeId, queryClient]);

  return {
    query,
    live,
    /** Reload the map from the server (after a 409, or on demand). */
    reload: () => queryClient.refetchQueries({ queryKey, exact: true }),
  };
}
