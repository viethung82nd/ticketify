import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Types of the transactional outbox events (PLAN §7). Written in the same transaction as the
 * change they announce, as `PENDING`; the relay that hands them to BullMQ comes in ROADMAP 4.1.
 */
export const OutboxEventType = {
  /** The booking is CONFIRMED and its tickets are issued: deliver them (PDF, email, notify). */
  BOOKING_CONFIRMED: 'booking.confirmed',
  /** Paid, but the seats could not be kept: apologise to the user and tell an admin. */
  BOOKING_NEEDS_REVIEW: 'booking.needs_review',
  /**
   * Seats went back to AVAILABLE: tell the browsers watching the showtime. Written by the IPN when
   * a booking goes to review; `expireBooking` writes it too from ROADMAP 4.1.
   */
  SEATS_RELEASED: 'seats.released',
} as const;
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

export interface OutboxEventInput {
  type: OutboxEventType;
  /** Id of the row the event is about (a booking id for the events above). */
  aggregateId: string;
  payload: Prisma.InputJsonObject;
}

/**
 * Appends one `PENDING` event, due at once. Call it inside the transaction whose change it
 * announces: if that transaction rolls back, the event was never written.
 */
export async function writeOutboxEvent(tx: Tx, event: OutboxEventInput, now: Date): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      type: event.type,
      aggregateId: event.aggregateId,
      payload: event.payload,
      nextRetryAt: now,
      createdAt: now,
    },
    select: { id: true },
  });
}
