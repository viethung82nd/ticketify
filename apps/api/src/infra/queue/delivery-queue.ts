import { OutboxEventType } from '../outbox/outbox-events';

/**
 * The `delivery` BullMQ queue: everything that happens AFTER a payment transaction committed
 * (PLAN §7). Separate from the `bookings` queue on purpose: a slow PDF or an SMTP outage must
 * never delay a hold expiry, and the two have different retry budgets.
 *
 * Jobs are fed by the outbox relay (ROADMAP 4.1), never by the API: the only thing that makes a
 * delivery job exist is a committed `outbox_events` row.
 */
export const DELIVERY_QUEUE = 'delivery';

/** One step of the delivery pipeline; the BullMQ job name. */
export const DeliveryAction = {
  /** `booking.confirmed`: render the tickets to a PDF and upload it (ROADMAP 4.4, 4.5). */
  GENERATE_PDF: 'generate-pdf',
  /** Email the user: tickets, or the apology of a booking under review (ROADMAP 4.6). */
  SEND_EMAIL: 'send-email',
  /** Store a `Notification` and push it over the socket (ROADMAP 4.2). */
  NOTIFY: 'notify',
  /** `seats.released`: tell the browsers watching the showtime. */
  BROADCAST_SEATS: 'broadcast-seats',
} as const;
export type DeliveryAction = (typeof DeliveryAction)[keyof typeof DeliveryAction];

/** What a delivery job carries: the outbox row it came from, payload included. */
export interface DeliveryJobData {
  /** `outbox_events.id`; with the action it makes the job id. */
  eventId: string;
  type: OutboxEventType;
  /** `outbox_events.aggregate_id`: the booking, or the payment of `payment.refund_required`. */
  aggregateId: string;
  /** `outbox_events.payload`, as it was written. Validated by the handler, never trusted raw. */
  payload: Record<string, unknown>;
}

/**
 * Job id of one step of one event, so a relay that hands the same event over twice (a claim lost
 * to a crash, a retried round) adds a single job per step.
 *
 * `{eventId}-{action}`, with a dash: BullMQ refuses custom ids containing `:` ("Custom Id cannot
 * contain :"), so PLAN §7's original `{eventId}:{action}` is not usable (ROADMAP "Đã chốt").
 */
export const deliveryJobId = (eventId: string, action: DeliveryAction): string =>
  `${eventId}-${action}`;

/**
 * Steps the relay enqueues for each event type, in this order. A type with no step yet is not
 * claimed at all (see `RELAYED_EVENT_TYPES`): its events stay `PENDING` until the worker that
 * knows how to deliver them runs, instead of being marked `PUBLISHED` and dropped.
 *
 * `send-email` of a confirmation is NOT listed: it needs the PDF, so `generate-pdf` enqueues it
 * once the file is in place (ROADMAP 4.4–4.6). `notify` is independent of both, so an SMTP or
 * storage outage never keeps the in-app notification from arriving.
 */
export const DELIVERY_ACTIONS: Readonly<Record<OutboxEventType, readonly DeliveryAction[]>> = {
  // GENERATE_PDF chains SEND_EMAIL once the file is in place (4.6).
  [OutboxEventType.BOOKING_CONFIRMED]: [DeliveryAction.NOTIFY, DeliveryAction.GENERATE_PDF],
  // 4.6 adds SEND_EMAIL (the apology to the user).
  [OutboxEventType.BOOKING_NEEDS_REVIEW]: [DeliveryAction.NOTIFY],
  [OutboxEventType.SEATS_RELEASED]: [DeliveryAction.BROADCAST_SEATS],
  // Admins only: the user paid twice but owes nothing, so telling them would only alarm them.
  [OutboxEventType.PAYMENT_REFUND_REQUIRED]: [DeliveryAction.NOTIFY],
};

/** Event types this build can deliver; the relay claims nothing else. */
export const RELAYED_EVENT_TYPES: readonly OutboxEventType[] = Object.entries(DELIVERY_ACTIONS)
  .filter(([, actions]) => actions.length > 0)
  .map(([type]) => type as OutboxEventType);

/** Steps of one event type, in order; empty when this build cannot deliver it. */
export const actionsOf = (type: OutboxEventType): readonly DeliveryAction[] =>
  DELIVERY_ACTIONS[type] ?? [];
