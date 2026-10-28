import { type ShowtimeSeatMap, showtimeSeatMapSchema } from '@ticketify/shared';
import { apiClient } from '@/lib/api-client';

/** `GET /showtimes/:id/seats`: the source of truth for seat states (realtime is only a hint). */
export async function getSeatMap(showtimeId: string): Promise<ShowtimeSeatMap> {
  const res = await apiClient.get<unknown>(`/showtimes/${showtimeId}/seats`);
  return showtimeSeatMapSchema.parse(res.data);
}

export const seatMapKeys = {
  all: ['seat-map'] as const,
  showtime: (showtimeId: string) => ['seat-map', showtimeId] as const,
};
