import { BookingStatus, ShowtimeSeatStatus, ShowtimeStatus } from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { reclaimSeatsForExpiredBooking } from './reclaim-seats';
import { mockTx, writes } from './testing/mock-tx';

const at = (iso: string): Date => new FakeClock(iso).now();
const NOW = at('2026-11-01T10:20:00.000Z');
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const OTHER_ID = '01a17e75-7100-7679-b8b1-000000000002';
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_A = '01a17e75-7100-7679-b8b1-0000000000c1';
const SEAT_B = '01a17e75-7100-7679-b8b1-0000000000c2';
const STARTS_AT = at('2026-11-02T12:00:00.000Z');
const ENDS_AT = at('2026-11-02T13:55:00.000Z');

const expired = [{ status: BookingStatus.EXPIRED, showtime_id: SHOWTIME_ID }];
const scheduled = [{ status: ShowtimeStatus.SCHEDULED, starts_at: STARTS_AT, ends_at: ENDS_AT }];
const seat = (
  seatId: string,
  status: ShowtimeSeatStatus,
  bookingId: string | null = null,
  heldUntil: Date | null = null,
) => ({ seat_id: seatId, status, booking_id: bookingId, held_until: heldUntil });
const free = [
  seat(SEAT_A, ShowtimeSeatStatus.AVAILABLE),
  seat(SEAT_B, ShowtimeSeatStatus.AVAILABLE),
];

describe('reclaimSeatsForExpiredBooking', () => {
  it('locks the seats of booking_seats in seat_id order before reading the showtime', async () => {
    const { tx, statements } = mockTx([expired, free, scheduled], [2]);

    await reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW);

    expect(statements[1]?.sql).toMatch(
      /FROM showtime_seats WHERE \(showtime_id, seat_id\) IN \( SELECT showtime_id, seat_id FROM booking_seats WHERE booking_id = \$::uuid\) ORDER BY seat_id FOR UPDATE$/,
    );
    expect(statements[2]?.sql).toContain('FROM showtimes');
  });

  it('every seat free: one conditional UPDATE back to HELD for the booking', async () => {
    const { tx, statements } = mockTx([expired, free, scheduled], [2]);

    await expect(reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW)).resolves.toEqual({
      reclaimed: true,
      seatIds: [SEAT_A, SEAT_B],
      showtime: { id: SHOWTIME_ID, status: 'SCHEDULED', startsAt: STARTS_AT, endsAt: ENDS_AT },
    });
    const [update] = writes(statements);
    expect(update?.sql).toContain(
      "SET status = 'HELD', booking_id = $::uuid, held_until = $ WHERE showtime_id = $::uuid AND seat_id = ANY($::uuid[]) AND (status = 'AVAILABLE' OR (status = 'HELD' AND (booking_id = $::uuid OR held_until <= $)))",
    );
    expect(update?.values).toEqual([
      BOOKING_ID,
      NOW,
      SHOWTIME_ID,
      [SEAT_A, SEAT_B],
      BOOKING_ID,
      NOW,
    ]);
  });

  it('a seat another booking held but let expire is taken back too (lazy expiry)', async () => {
    const seats = [
      seat(SEAT_A, ShowtimeSeatStatus.AVAILABLE),
      seat(SEAT_B, ShowtimeSeatStatus.HELD, OTHER_ID, at('2026-11-01T10:19:59.000Z')),
    ];
    const { tx } = mockTx([expired, seats, scheduled], [2]);

    await expect(reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW)).resolves.toMatchObject({
      reclaimed: true,
    });
  });

  it.each([
    [
      'one seat SOLD',
      [seat(SEAT_A, ShowtimeSeatStatus.AVAILABLE), seat(SEAT_B, ShowtimeSeatStatus.SOLD, OTHER_ID)],
      'SEAT_SOLD',
    ],
    [
      'one seat held by a live booking',
      [
        seat(SEAT_A, ShowtimeSeatStatus.AVAILABLE),
        seat(SEAT_B, ShowtimeSeatStatus.HELD, OTHER_ID, at('2026-11-01T10:30:00.000Z')),
      ],
      'SEAT_HELD_BY_OTHER',
    ],
  ])('%s: nothing is updated (all or nothing)', async (_label, seats, reason) => {
    const { tx, statements } = mockTx([expired, seats, scheduled]);

    await expect(reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW)).resolves.toMatchObject({
      reclaimed: false,
      problem: { reason, seatIds: [SEAT_B] },
    });
    expect(writes(statements)).toEqual([]);
  });

  it('a cancelled showtime: nothing is updated', async () => {
    const cancelled = [
      { status: ShowtimeStatus.CANCELLED, starts_at: STARTS_AT, ends_at: ENDS_AT },
    ];
    const { tx, statements } = mockTx([expired, free, cancelled]);

    await expect(reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW)).resolves.toMatchObject({
      reclaimed: false,
      problem: { reason: 'SHOWTIME_CANCELLED', seatIds: [] },
    });
    expect(writes(statements)).toEqual([]);
  });

  it('a showtime that is over: nothing is updated (SHOWTIME_ENDED)', async () => {
    const over = [
      { status: ShowtimeStatus.SCHEDULED, starts_at: at('2026-11-01T08:00:00.000Z'), ends_at: NOW },
    ];
    const { tx, statements } = mockTx([expired, free, over]);

    await expect(reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW)).resolves.toMatchObject({
      reclaimed: false,
      problem: { reason: 'SHOWTIME_ENDED', seatIds: [] },
    });
    expect(writes(statements)).toEqual([]);
  });

  it.each([BookingStatus.PENDING, BookingStatus.CONFIRMED])(
    'refuses a %s booking (only an expired booking reclaims)',
    async (status) => {
      const { tx, statements } = mockTx([[{ status, showtime_id: SHOWTIME_ID }]]);

      await expect(reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW)).rejects.toThrow(
        'is not EXPIRED',
      );
      expect(statements).toHaveLength(1);
    },
  );

  it('an UPDATE that changes fewer rows than locked throws (the IPN rolls back)', async () => {
    const { tx } = mockTx([expired, free, scheduled], [1]);

    await expect(reclaimSeatsForExpiredBooking(tx, BOOKING_ID, NOW)).rejects.toThrow(
      'updated 1 of 2 locked seats',
    );
  });
});
