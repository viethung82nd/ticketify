import type { PrismaClient } from '../../../src/generated/prisma/client';

/**
 * Every rule that must hold over the **whole** database after any number of IPNs, expiries and
 * holds have run — the same set `payment-ipn.int-spec.ts` checks after each of its tests and race
 * rounds (ROADMAP 3.4), as named violations so a failure says what broke. Each query returns the
 * offending rows, so "all good" is every list empty.
 *
 * Scenario C asserts on these rather than on responses: an IPN that answers `00` while leaving two
 * live tickets on one seat is a failure, however correct its answer looked.
 *
 * `payment-ipn.int-spec.ts` keeps its own copy of these queries. The two drifted once — 4.1 taught
 * that copy that `expireBooking` also writes `seats.released` while 3.9 wrote this one from the
 * older rule, and the merge of the two branches broke scenario C — so change both together.
 */
export interface PaymentViolations {
  /** Two live tickets for one seat. The partial unique index should make this impossible. */
  duplicateTickets: unknown[];
  /** A CONFIRMED booking that does not own every one of its seats, SOLD. */
  confirmedNotSold: unknown[];
  /** A SOLD seat whose booking is not CONFIRMED or NEEDS_REVIEW. */
  soldWithoutPaidBooking: unknown[];
  /** A ticket of a booking that is not CONFIRMED. */
  ticketsOfUnconfirmed: unknown[];
  /** A CONFIRMED booking with a different number of live tickets than seats. */
  ticketCountMismatch: unknown[];
  /** A SUCCESS payment whose booking is neither CONFIRMED nor NEEDS_REVIEW. */
  successNotSettled: unknown[];
  /** A seat still HELD by a booking that is over (EXPIRED, CONFIRMED, NEEDS_REVIEW). */
  heldByOver: unknown[];
  /**
   * Not exactly one outbox event per settled booking, or a `seats.released` its cause cannot
   * explain: more than one per flow, a review one on a booking not under review, or an unknown
   * cause.
   */
  outboxMismatch: unknown[];
  /** A REFUND_REQUIRED payment without its event, or without a SUCCESS payment beside it. */
  refundMismatch: unknown[];
  /** An attempt left PENDING on an EXPIRED booking: the expiry must EXPIRE them all (3.7). */
  pendingAfterExpiry: unknown[];
}

export const NO_PAYMENT_VIOLATIONS: PaymentViolations = {
  duplicateTickets: [],
  confirmedNotSold: [],
  soldWithoutPaidBooking: [],
  ticketsOfUnconfirmed: [],
  ticketCountMismatch: [],
  successNotSettled: [],
  heldByOver: [],
  outboxMismatch: [],
  refundMismatch: [],
  pendingAfterExpiry: [],
};

export async function paymentViolations(prisma: PrismaClient): Promise<PaymentViolations> {
  const q = <T>(sql: TemplateStringsArray) => prisma.$queryRaw<T[]>(sql);
  const [
    duplicateTickets,
    confirmedNotSold,
    soldWithoutPaidBooking,
    ticketsOfUnconfirmed,
    ticketCountMismatch,
    successNotSettled,
    heldByOver,
    outboxMismatch,
    refundMismatch,
    pendingAfterExpiry,
  ] = await Promise.all([
    q`SELECT showtime_id, seat_id, count(*)::int AS n FROM tickets WHERE status <> 'VOID'
      GROUP BY showtime_id, seat_id HAVING count(*) > 1`,
    q`SELECT b.id, bs.seat_id FROM bookings b
      JOIN booking_seats bs ON bs.booking_id = b.id
      JOIN showtime_seats ss ON ss.showtime_id = bs.showtime_id AND ss.seat_id = bs.seat_id
      WHERE b.status = 'CONFIRMED'
        AND (ss.status <> 'SOLD' OR ss.booking_id IS DISTINCT FROM b.id)`,
    q`SELECT ss.showtime_id, ss.seat_id FROM showtime_seats ss
      LEFT JOIN bookings b ON b.id = ss.booking_id
      WHERE ss.status = 'SOLD'
        AND (b.id IS NULL OR b.status NOT IN ('CONFIRMED', 'NEEDS_REVIEW'))`,
    q`SELECT t.id FROM tickets t JOIN bookings b ON b.id = t.booking_id
      WHERE b.status <> 'CONFIRMED'`,
    q`SELECT b.id FROM bookings b WHERE b.status = 'CONFIRMED'
      AND (SELECT count(*) FROM tickets t WHERE t.booking_id = b.id AND t.status <> 'VOID')
        <> (SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id)`,
    q`SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.status = 'SUCCESS' AND b.status NOT IN ('CONFIRMED', 'NEEDS_REVIEW')`,
    q`SELECT ss.seat_id FROM showtime_seats ss JOIN bookings b ON b.id = ss.booking_id
      WHERE ss.status = 'HELD' AND b.status IN ('EXPIRED', 'CONFIRMED', 'NEEDS_REVIEW')`,
    q`SELECT b.id, b.status::text AS status FROM bookings b
      LEFT JOIN outbox_events o ON o.aggregate_id = b.id::text
      GROUP BY b.id, b.status
      HAVING count(o.id) FILTER (WHERE o.type = 'booking.confirmed')
               <> CASE WHEN b.status = 'CONFIRMED' THEN 1 ELSE 0 END
          OR count(o.id) FILTER (WHERE o.type = 'booking.needs_review')
               <> CASE WHEN b.status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END
          -- seats.released is judged by its cause, because two different flows write it.
          -- Review (ROADMAP 3.5): at most one, and only for a booking under review; a booking
          -- with no held seat left of its own goes to review without one.
          OR count(o.id) FILTER (WHERE o.type = 'seats.released'
                 AND o.payload->>'cause' = 'booking.needs_review')
               > CASE WHEN b.status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END
          -- Expiry (ROADMAP 4.1): at most one, whatever the booking's final status. It is NOT
          -- limited to EXPIRED bookings: money that arrives after the hold ran out still settles
          -- the booking (3.7 branch B), so a CONFIRMED or NEEDS_REVIEW booking may carry the
          -- event of the expiry it went through earlier. expireBooking is idempotent (it stops at
          -- a booking that is no longer PENDING), so a second one would be a real bug.
          OR count(o.id) FILTER (WHERE o.type = 'seats.released'
                 AND o.payload->>'cause' = 'booking.expired') > 1
          -- Any other cause, or none, is a bug: SeatsReleasedCause has exactly these two.
          OR count(o.id) FILTER (WHERE o.type = 'seats.released'
                 AND coalesce(o.payload->>'cause', '')
                       NOT IN ('booking.needs_review', 'booking.expired')) > 0`,
    q`SELECT p.id FROM payments p
      WHERE (SELECT count(*) FROM outbox_events o
             WHERE o.aggregate_id = p.id::text AND o.type = 'payment.refund_required')
              <> CASE WHEN p.status = 'REFUND_REQUIRED' THEN 1 ELSE 0 END
         OR (p.status = 'REFUND_REQUIRED' AND NOT EXISTS (
              SELECT 1 FROM payments s
              WHERE s.booking_id = p.booking_id AND s.status = 'SUCCESS'))`,
    // An EXPIRED booking keeps no attempt waiting: the expiry sets every PENDING one EXPIRED (3.7).
    // CONFIRMED and NEEDS_REVIEW are left out on purpose: a customer who opened a second payment
    // page and never paid it leaves that attempt PENDING, and only its own IPN decides it.
    q`SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.status = 'PENDING' AND b.status = 'EXPIRED'`,
  ]);
  return {
    duplicateTickets,
    confirmedNotSold,
    soldWithoutPaidBooking,
    ticketsOfUnconfirmed,
    ticketCountMismatch,
    successNotSettled,
    heldByOver,
    outboxMismatch,
    refundMismatch,
    pendingAfterExpiry,
  };
}

/** The violations as one-line strings, for a round report. */
export function formatPaymentViolations(found: PaymentViolations): string[] {
  const names = Object.keys(NO_PAYMENT_VIOLATIONS) as (keyof PaymentViolations)[];
  return names.flatMap((name) => {
    const rows = found[name];
    return rows.length > 0 ? [`${name}: ${JSON.stringify(rows)}`] : [];
  });
}
