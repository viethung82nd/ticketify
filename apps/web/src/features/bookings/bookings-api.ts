import {
  bookingAlreadyPendingDetailsSchema,
  type Booking,
  bookingSchema,
  type ComboItem,
  tooManyAttemptsDetailsSchema,
} from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';
import { apiErrorOf } from '@/lib/api-error';
import { serverOffsetOf } from '@/lib/server-clock';

export interface HoldRequest {
  showtimeId: string;
  seatIds: string[];
  comboItems: ComboItem[];
}

/**
 * `POST /bookings`. `idempotencyKey` must stay the same for a retry of the same selection, so a
 * request that reached the server but whose answer was lost returns that booking instead of
 * failing with "already pending".
 */
export async function holdBooking(body: HoldRequest, idempotencyKey: string): Promise<Booking> {
  const res = await apiClient.post<unknown>('/bookings', body, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  return bookingSchema.parse(res.data);
}

export interface TimedBooking {
  booking: Booking;
  /** Server clock − local clock (ms), from the response's `Date`; `null` if unreadable. */
  serverOffsetMs: number | null;
}

/** `GET /bookings/:id` plus the server clock offset taken from the same response. */
export async function getBooking(id: string): Promise<TimedBooking> {
  const res = await apiClient.get<unknown>(`/bookings/${id}`);
  return {
    booking: bookingSchema.parse(res.data),
    serverOffsetMs: serverOffsetOf(res, Date.now()),
  };
}

export const bookingKeys = {
  detail: (id: string) => ['bookings', id] as const,
};

/** A 4xx (404 not mine, 400) will not change on retry. */
const retryUnlessClientError = (failureCount: number, error: unknown): boolean => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return failureCount < 1 && !(status !== undefined && status >= 400 && status < 500);
};

/** Polls every 30 s so a status change (payment from week 11, expiry) shows without a reload. */
export const useBooking = (id: string) =>
  useQuery({
    queryKey: bookingKeys.detail(id),
    queryFn: () => getBooking(id),
    retry: retryUnlessClientError,
    staleTime: 0,
    refetchInterval: 30_000,
  });

// ─── Errors of POST /bookings ───

const seatIdsDetails = z.object({ seatIds: z.array(z.string()) });

export const seatIdsOf = (error: unknown): string[] => {
  const parsed = seatIdsDetails.safeParse(apiErrorOf(error)?.details);
  return parsed.success ? parsed.data.seatIds : [];
};

/** The booking behind a `409 BOOKING_ALREADY_PENDING`: its id and when it stops blocking. */
export const pendingBookingOf = (
  error: unknown,
): { existingBookingId: string; expiresAt: string } | undefined => {
  const parsed = bookingAlreadyPendingDetailsSchema.safeParse(apiErrorOf(error)?.details);
  return parsed.success ? parsed.data : undefined;
};

export const retryAfterOf = (error: unknown): number | undefined => {
  const parsed = tooManyAttemptsDetailsSchema.safeParse(apiErrorOf(error)?.details);
  return parsed.success ? parsed.data.retryAfterSeconds : undefined;
};
