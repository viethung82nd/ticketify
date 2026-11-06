import {
  type CheckInRequest,
  type CheckInResponse,
  checkInResponseSchema,
  type TicketPdfLink,
  ticketPdfLinkSchema,
} from '@ticketify/shared';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

/** `POST /tickets/check-in` (staff). Every verdict is a 200; only a bad request throws. */
export async function checkInTicket(body: CheckInRequest): Promise<CheckInResponse> {
  const res = await apiClient.post<unknown>('/tickets/check-in', body);
  return checkInResponseSchema.parse(res.data);
}

/** `GET /bookings/:id/ticket-pdf`: a short-lived link straight to object storage. */
export async function getTicketPdfLink(bookingId: string): Promise<TicketPdfLink> {
  const res = await apiClient.get<unknown>(`/bookings/${bookingId}/ticket-pdf`);
  return ticketPdfLinkSchema.parse(res.data);
}

export const useCheckIn = () => useMutation({ mutationFn: checkInTicket });

/**
 * Asks for a fresh link and opens it. The link is minutes long and the file is served by storage,
 * so there is nothing to keep: each download asks again.
 */
export const useTicketPdf = () =>
  useMutation({
    mutationFn: getTicketPdfLink,
    onSuccess: (link) => {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
  });
