import { z } from 'zod';

/** Tickets: the PDF of a booking (ROADMAP 4.5) and, from 4.7, check-in. */

export const TICKET_LIMITS = {
  /** Lifetime of a presigned ticket PDF link: long enough to open, short enough not to share. */
  pdfUrlTtlSeconds: 5 * 60,
  /** Characters of a `tickets.code` (`TicketCodes`). */
  codeLength: 12,
} as const;

/** Where a booking's PDF lives in object storage. One fixed key, overwritten in place. */
export const TICKET_PDF_PREFIX = 'tickets/';

export const ticketPdfKey = (bookingId: string): string => `${TICKET_PDF_PREFIX}${bookingId}.pdf`;

/** What `GET /bookings/:id/ticket-pdf` answers: a short-lived link straight to storage. */
export const ticketPdfLinkSchema = z.object({
  url: z.string(),
  /** Seconds the link stays valid. */
  expiresIn: z.number().int(),
});
export type TicketPdfLink = z.infer<typeof ticketPdfLinkSchema>;

export const TicketErrorCode = {
  /** The booking is not CONFIRMED, so it has no ticket and never had a PDF. */
  BOOKING_NOT_CONFIRMED: 'BOOKING_NOT_CONFIRMED',
  /** Confirmed, but the worker has not uploaded the file yet: try again in a moment. */
  TICKET_PDF_NOT_READY: 'TICKET_PDF_NOT_READY',
} as const;
export type TicketErrorCode = (typeof TicketErrorCode)[keyof typeof TicketErrorCode];
