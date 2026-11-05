import { BookingStatus } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { expireBooking } from './expire-booking';

const at = (iso: string): Date => new FakeClock(iso).now();
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const HOLD_UNTIL = at('2026-11-01T10:15:00.000Z');
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_A = '01a17e75-7100-7679-b8b1-0000000000c1';
const SEAT_B = '01a17e75-7100-7679-b8b1-0000000000c2';

/** One SQL statement the mock transaction received: the text (whitespace squeezed) and values. */
interface Statement {
  sql: string;
  values: unknown[];
}

/**
 * Stand-in for the transaction client: `$queryRaw` answers from `rows` in order, `$executeRaw`
 * answers `affected` (row counts) in order. Every statement is recorded.
 */
function mockTx(rows: unknown[][], affected: number[] = []) {
  const statements: Statement[] = [];
  const record = (strings: TemplateStringsArray, values: unknown[]) =>
    statements.push({ sql: strings.join('$').replace(/\s+/g, ' ').trim(), values });
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(rows.shift() ?? []);
    }),
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(affected.shift() ?? 0);
    }),
    // The outbox write is the one statement that goes through the Prisma API, not raw SQL.
    outboxEvent: {
      create: jest.fn(({ data }: { data: unknown }) => {
        statements.push({ sql: 'INSERT INTO outbox_events', values: [data] });
        return Promise.resolve({ id: 'outbox-1' });
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, statements };
}

const lockedBooking = (status: BookingStatus) => [
  { status, hold_until: HOLD_UNTIL, showtime_id: SHOWTIME_ID },
];
const writes = (statements: Statement[]) =>
  statements.filter((s) => s.sql.startsWith('UPDATE') || s.sql.startsWith('INSERT'));

describe('expireBooking', () => {
  it('locks the booking row FOR UPDATE SKIP LOCKED first', async () => {
    const { tx, statements } = mockTx([lockedBooking(BookingStatus.EXPIRED)]);

    await expireBooking(tx, BOOKING_ID, HOLD_UNTIL);

    expect(statements[0]?.sql).toMatch(/FROM bookings WHERE id = \$::uuid FOR UPDATE SKIP LOCKED$/);
    expect(statements[0]?.values).toEqual([BOOKING_ID]);
  });

  it.each([BookingStatus.EXPIRED, BookingStatus.CONFIRMED, BookingStatus.NEEDS_REVIEW])(
    'noop when the booking is %s: nothing is written',
    async (status) => {
      const { tx, statements } = mockTx([lockedBooking(status)]);

      await expect(expireBooking(tx, BOOKING_ID, at('2026-11-02T00:00:00.000Z'))).resolves.toEqual({
        outcome: 'noop',
      });
      expect(writes(statements)).toEqual([]);
    },
  );

  it('noop for an unknown booking', async () => {
    const { tx, statements } = mockTx([[], []]);

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL)).resolves.toEqual({ outcome: 'noop' });
    expect(statements).toHaveLength(2);
    expect(writes(statements)).toEqual([]);
  });

  it('skipped when the row exists but another transaction holds it', async () => {
    const { tx, statements } = mockTx([[], [{ found: 1 }]]);

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL)).resolves.toEqual({
      outcome: 'skipped',
    });
    expect(writes(statements)).toEqual([]);
  });

  it('early while now < holdUntil: returns holdUntil, writes nothing', async () => {
    const { tx, statements } = mockTx([lockedBooking(BookingStatus.PENDING)]);

    await expect(expireBooking(tx, BOOKING_ID, at('2026-11-01T10:14:59.999Z'))).resolves.toEqual({
      outcome: 'early',
      holdUntil: HOLD_UNTIL,
    });
    expect(writes(statements)).toEqual([]);
  });

  it('expired from holdUntil on: booking EXPIRED, then its own HELD seats locked and released', async () => {
    const now = HOLD_UNTIL;
    const { tx, statements } = mockTx(
      [lockedBooking(BookingStatus.PENDING), [], [{ seat_id: SEAT_B }, { seat_id: SEAT_A }]],
      [1],
    );

    await expect(expireBooking(tx, BOOKING_ID, now)).resolves.toEqual({
      outcome: 'expired',
      showtimeId: SHOWTIME_ID,
      releasedSeatIds: [SEAT_A, SEAT_B],
    });

    const [, expire, lockSeats, release, outbox] = statements;
    expect(expire?.sql).toBe(
      "UPDATE bookings SET status = 'EXPIRED', updated_at = $ WHERE id = $::uuid",
    );
    expect(expire?.values).toEqual([now, BOOKING_ID]);
    // Lock order: booking (above), then seats in seat_id order.
    expect(lockSeats?.sql).toBe(
      "SELECT seat_id FROM showtime_seats WHERE booking_id = $::uuid AND status = 'HELD' " +
        'ORDER BY seat_id FOR UPDATE',
    );
    // Conditional release: only seats still HELD by this booking (lazy expiry, SOLD seats).
    expect(release?.sql).toBe(
      "UPDATE showtime_seats SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL " +
        "WHERE booking_id = $::uuid AND status = 'HELD' RETURNING seat_id",
    );
    expect(release?.values).toEqual([BOOKING_ID]);
    // And one seats.released event, in the same transaction as the release (ROADMAP 4.1).
    expect(outbox?.sql).toBe('INSERT INTO outbox_events');
    expect(outbox?.values[0]).toEqual({
      type: 'seats.released',
      aggregateId: BOOKING_ID,
      payload: {
        bookingId: BOOKING_ID,
        showtimeId: SHOWTIME_ID,
        seatIds: [SEAT_A, SEAT_B],
        cause: 'booking.expired',
      },
      nextRetryAt: now,
      createdAt: now,
    });
    expect(statements).toHaveLength(5);
  });

  it('expired with 0 released seats when another booking already took them all', async () => {
    const { tx, statements } = mockTx([lockedBooking(BookingStatus.PENDING), [], []], [1]);

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL)).resolves.toEqual({
      outcome: 'expired',
      showtimeId: SHOWTIME_ID,
      releasedSeatIds: [],
    });

    // Nothing was released, so there is nothing to announce: no outbox event.
    expect(statements.map((s) => s.sql)).not.toContain('INSERT INTO outbox_events');
  });
});
