import {
  type Booking,
  bookingSchema,
  type ComboItem,
  tooManyAttemptsDetailsSchema,
} from '@ticketify/shared';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';
import { apiErrorOf } from '@/lib/api-error';

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

// ─── Errors of POST /bookings ───

const seatIdsDetails = z.object({ seatIds: z.array(z.string()) });
const bookingIdDetails = z.object({ bookingId: z.string() });

export const seatIdsOf = (error: unknown): string[] => {
  const parsed = seatIdsDetails.safeParse(apiErrorOf(error)?.details);
  return parsed.success ? parsed.data.seatIds : [];
};

export const pendingBookingIdOf = (error: unknown): string | undefined => {
  const parsed = bookingIdDetails.safeParse(apiErrorOf(error)?.details);
  return parsed.success ? parsed.data.bookingId : undefined;
};

export const retryAfterOf = (error: unknown): number | undefined => {
  const parsed = tooManyAttemptsDetailsSchema.safeParse(apiErrorOf(error)?.details);
  return parsed.success ? parsed.data.retryAfterSeconds : undefined;
};
