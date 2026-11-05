import type { Prisma } from '../../generated/prisma/client';
import type { OutboxEventType } from './outbox-events';

/**
 * Statements of the outbox relay (ROADMAP 4.1). Each one runs on its own (no interactive
 * transaction): claiming is a single `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`, so it
 * is atomic by itself and never holds a lock across a Redis round-trip.
 */

/** Accepts the Prisma client or a transaction client: only raw statements are used. */
export type OutboxDb = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Events one round claims. Large enough to drain a burst, small enough to retry cheaply. */
export const OUTBOX_BATCH_SIZE = 50;

/**
 * Rounds in which one event may fail to reach BullMQ before it is given up on (`FAILED`, with
 * `last_error`). With the backoff below that is about 25 minutes of trying.
 */
export const OUTBOX_MAX_ATTEMPTS = 10;

/** Backoff of a failed hand-over: 2 s, 4 s, 8 s … capped at 5 minutes. */
export const OUTBOX_RETRY_BASE_MS = 2_000;
export const OUTBOX_RETRY_MAX_MS = 300_000;

/**
 * After this long a `PROCESSING` row is considered abandoned (the worker that claimed it was
 * killed between the claim and the hand-over) and goes back to `PENDING`. Longer than any
 * plausible `addBulk`, shorter than a person's patience.
 */
export const OUTBOX_STALE_CLAIM_MS = 60_000;

/** Delay before the `attempts`-th retry (1-based), exponential and capped. */
export const retryDelayMs = (attempts: number): number =>
  Math.min(OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_RETRY_MAX_MS);

/** When a claim that failed on its `attempts`-th try may be claimed again. */
export const nextRetryAt = (now: Date, attempts: number): Date =>
  new Date(now.getTime() + retryDelayMs(attempts));

/** One row the relay has claimed; `attempts` already counts this round. */
export interface ClaimedEvent {
  id: string;
  type: OutboxEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface ClaimedRow {
  id: string;
  type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
}

export interface ClaimOptions {
  now: Date;
  /** Goes into `locked_by`, so a stuck claim names the process that took it. */
  lockedBy: string;
  /** Only these types; a type this build cannot deliver is left alone (see `DELIVERY_ACTIONS`). */
  types: readonly OutboxEventType[];
  limit?: number;
}

/**
 * Claims up to `limit` due events for this process: `PENDING`, due, of a known type, oldest due
 * first. `FOR UPDATE SKIP LOCKED` inside the CTE means two relays (or two rounds of one relay)
 * never claim the same row and never wait for each other. `attempts` is incremented here, when
 * the row is taken, so a worker killed before the hand-over still counts its try.
 */
export async function claimOutboxBatch(
  db: OutboxDb,
  options: ClaimOptions,
): Promise<ClaimedEvent[]> {
  const { now, lockedBy, types, limit = OUTBOX_BATCH_SIZE } = options;
  if (types.length === 0) return [];
  const rows = await db.$queryRaw<ClaimedRow[]>`
    WITH due AS (
      SELECT id FROM outbox_events
      WHERE status = 'PENDING'
        AND next_retry_at <= ${now}
        AND type = ANY(${[...types]}::text[])
      ORDER BY next_retry_at, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events e
    SET status = 'PROCESSING', locked_at = ${now}, locked_by = ${lockedBy},
        attempts = e.attempts + 1
    FROM due
    WHERE e.id = due.id
    RETURNING e.id, e.type, e.aggregate_id, e.payload, e.attempts`;
  return rows.map((row) => ({
    id: row.id,
    type: row.type as OutboxEventType,
    aggregateId: row.aggregate_id,
    payload: asPayload(row.payload),
    attempts: row.attempts,
  }));
}

/** The jobs of these events are in BullMQ: the relay is done with them. */
export async function markPublished(db: OutboxDb, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return db.$executeRaw`
    UPDATE outbox_events
    SET status = 'PUBLISHED', locked_at = NULL, locked_by = NULL, last_error = NULL
    WHERE id = ANY(${[...ids]}::uuid[])`;
}

/**
 * The hand-over failed: back to `PENDING` with a backoff and the reason, or `FAILED` once the
 * attempts are used up (nothing retries it then; the row and its `last_error` stay for a person).
 * Returns the status written.
 */
export async function markRetry(
  db: OutboxDb,
  event: Pick<ClaimedEvent, 'id' | 'attempts'>,
  now: Date,
  error: unknown,
): Promise<'PENDING' | 'FAILED'> {
  const giveUp = event.attempts >= OUTBOX_MAX_ATTEMPTS;
  const status = giveUp ? 'FAILED' : 'PENDING';
  const message = reasonOf(error);
  await db.$executeRaw`
    UPDATE outbox_events
    SET status = ${status}::outbox_status, next_retry_at = ${nextRetryAt(now, event.attempts)},
        locked_at = NULL, locked_by = NULL, last_error = ${message}
    WHERE id = ${event.id}::uuid`;
  return status;
}

/**
 * Puts rows claimed by a process that never came back (a killed worker, kịch bản D) back in the
 * queue, due at once — or `FAILED` when they have used up their attempts. Run before each claim:
 * without it one crash would park an event in `PROCESSING` forever.
 */
export async function reclaimStaleClaims(db: OutboxDb, now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - OUTBOX_STALE_CLAIM_MS);
  return db.$executeRaw`
    UPDATE outbox_events
    SET status = CASE WHEN attempts >= ${OUTBOX_MAX_ATTEMPTS} THEN 'FAILED'::outbox_status
                      ELSE 'PENDING'::outbox_status END,
        next_retry_at = ${now}, locked_at = NULL, locked_by = NULL,
        last_error = ${'claim expired: the worker holding it stopped before handing the event over'}
    WHERE status = 'PROCESSING' AND locked_at < ${staleBefore}`;
}

/** First line of an error, short enough for a `last_error` column read by a person. */
export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.slice(0, 500) ?? 'unknown error';
}

/** `payload` is `jsonb`; anything but an object means the writer and this build disagree. */
function asPayload(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
