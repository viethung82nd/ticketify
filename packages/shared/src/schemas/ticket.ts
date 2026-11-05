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

// ─── Check-in (ROADMAP 4.7) ───

/**
 * What one check-in attempt turned out to be. Every verdict comes back with HTTP 200: a staff
 * device at the door wants an answer to show, not an exception to handle, and "this code does not
 * exist" is as normal an answer as "welcome in".
 */
export const CheckInResult = {
  /** The ticket was ISSUED and is now CHECKED_IN. The only verdict that lets someone in. */
  OK: 'OK',
  /** It had already been checked in; `ticket.checkedInAt` says when. */
  ALREADY_USED: 'ALREADY_USED',
  /** A real ticket, but for another showtime than the door being watched. */
  WRONG_SHOWTIME: 'WRONG_SHOWTIME',
  /** The ticket was voided (a refund, an admin correction). */
  VOID: 'VOID',
  /** No ticket has this code, or the QR token's signature does not check out. */
  NOT_FOUND: 'NOT_FOUND',
} as const;
export type CheckInResult = (typeof CheckInResult)[keyof typeof CheckInResult];

/**
 * `POST /tickets/check-in`: either a `token` (the whole QR payload, signature included) or a
 * `code` typed by hand, never both. `showtimeId` is the showtime whose door is being watched;
 * leave it out to accept a ticket for any showtime.
 */
export const checkInRequestSchema = z
  .object({
    token: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    showtimeId: z.uuid().optional(),
  })
  .refine((body) => Boolean(body.token) !== Boolean(body.code), {
    error: 'Provide either token or code, not both',
  });
export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

/** What the door needs to show the person holding the ticket. */
export const checkedTicketSchema = z.object({
  code: z.string(),
  seatLabel: z.string(),
  status: z.string(),
  movieTitle: z.string(),
  roomName: z.string(),
  /** ISO instant the showtime starts. */
  showtimeStartsAt: z.string(),
  showtimeId: z.uuid(),
  bookingCode: z.string(),
  /** ISO instant of the check-in: now for `OK`, the earlier one for `ALREADY_USED`. */
  checkedInAt: z.string().nullable(),
});
export type CheckedTicket = z.infer<typeof checkedTicketSchema>;

/** `ticket` is absent only for `NOT_FOUND`, where there is nothing to describe. */
export const checkInResponseSchema = z.object({
  result: z.enum(Object.values(CheckInResult)),
  ticket: checkedTicketSchema.optional(),
});
export type CheckInResponse = z.infer<typeof checkInResponseSchema>;

export const TicketErrorCode = {
  /** The booking is not CONFIRMED, so it has no ticket and never had a PDF. */
  BOOKING_NOT_CONFIRMED: 'BOOKING_NOT_CONFIRMED',
  /** Confirmed, but the worker has not uploaded the file yet: try again in a moment. */
  TICKET_PDF_NOT_READY: 'TICKET_PDF_NOT_READY',
} as const;
export type TicketErrorCode = (typeof TicketErrorCode)[keyof typeof TicketErrorCode];
