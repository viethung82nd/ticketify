import {
  BookingErrorCode,
  BookingStatus,
  ShowtimeSeatStatus,
  ShowtimeStatus,
} from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import {
  bookingCode,
  bookingTotals,
  holdDeadlines,
  isHoldExpired,
  missingCouplePartners,
  missingSeatIds,
  showtimeRefusal,
  unavailableSeatIds,
} from './booking-rules';

const at = (iso: string): Date => new FakeClock(iso).now();
const NOW = at('2026-11-01T10:00:00.000Z');
const SEAT = (n: number) => `01a17e75-7100-7679-b8b1-${String(n).padStart(12, '0')}`;

describe('holdDeadlines', () => {
  it('expiresAt = now + HOLD_TTL, holdUntil = expiresAt + PAYMENT_GRACE', () => {
    const { expiresAt, holdUntil } = holdDeadlines(NOW, 600, 300);

    expect(expiresAt.toISOString()).toBe('2026-11-01T10:10:00.000Z');
    expect(holdUntil.toISOString()).toBe('2026-11-01T10:15:00.000Z');
  });

  it('a zero grace keeps the seats exactly until expiresAt', () => {
    const { expiresAt, holdUntil } = holdDeadlines(NOW, 600, 0);
    expect(holdUntil).toEqual(expiresAt);
  });
});

describe('showtimeRefusal', () => {
  const startsAt = at('2026-11-01T12:00:00.000Z');

  it('a SCHEDULED showtime that starts later can be booked', () => {
    expect(showtimeRefusal({ status: ShowtimeStatus.SCHEDULED, startsAt }, NOW)).toBeNull();
  });

  it('SHOWTIME_STARTED from startsAt on (startsAt <= now), not only after it', () => {
    const scheduled = { status: ShowtimeStatus.SCHEDULED, startsAt };
    expect(showtimeRefusal(scheduled, at('2026-11-01T11:59:59.999Z'))).toBeNull();
    expect(showtimeRefusal(scheduled, startsAt)).toBe(BookingErrorCode.SHOWTIME_STARTED);
  });

  it('CANCELLED wins over STARTED', () => {
    expect(
      showtimeRefusal({ status: ShowtimeStatus.CANCELLED, startsAt }, at('2026-11-01T13:00:00Z')),
    ).toBe(BookingErrorCode.SHOWTIME_CANCELLED);
  });
});

describe('unavailableSeatIds (lazy expiry)', () => {
  const row = (n: number, status: ShowtimeSeatStatus, heldUntil: string | null = null) => ({
    seatId: SEAT(n),
    status,
    heldUntil: heldUntil === null ? null : at(heldUntil),
  });

  it('AVAILABLE and expired HELD (heldUntil <= now) are free; SOLD and live HELD are taken', () => {
    const rows = [
      row(1, ShowtimeSeatStatus.AVAILABLE),
      row(2, ShowtimeSeatStatus.HELD, '2026-11-01T09:59:59.999Z'),
      row(3, ShowtimeSeatStatus.HELD, '2026-11-01T10:00:00.000Z'),
      row(4, ShowtimeSeatStatus.HELD, '2026-11-01T10:00:00.001Z'),
      row(5, ShowtimeSeatStatus.SOLD),
    ];

    expect(unavailableSeatIds(rows, NOW)).toEqual([SEAT(4), SEAT(5)]);
  });
});

describe('missingSeatIds', () => {
  it('lists requested seats without a ShowtimeSeat row, in request order', () => {
    expect(missingSeatIds([SEAT(3), SEAT(1), SEAT(2)], [SEAT(1)])).toEqual([SEAT(3), SEAT(2)]);
    expect(missingSeatIds([SEAT(1)], [SEAT(1)])).toEqual([]);
  });
});

describe('missingCouplePartners', () => {
  // Pairs: group 1 = seats 1+2, group 2 = seats 3+4.
  const couples = [
    { id: SEAT(1), coupleGroup: 1 },
    { id: SEAT(2), coupleGroup: 1 },
    { id: SEAT(3), coupleGroup: 2 },
    { id: SEAT(4), coupleGroup: 2 },
  ];

  it('one seat of a pair without its partner → the partner is missing', () => {
    expect(missingCouplePartners([SEAT(1)], couples)).toEqual([SEAT(2)]);
    expect(missingCouplePartners([SEAT(4), SEAT(9)], couples)).toEqual([SEAT(3)]);
  });

  it('both seats of each pair → nothing missing', () => {
    expect(missingCouplePartners([SEAT(2), SEAT(1)], couples)).toEqual([]);
    expect(missingCouplePartners([SEAT(1), SEAT(2), SEAT(3), SEAT(4)], couples)).toEqual([]);
  });

  it('two half pairs → both partners missing, sorted', () => {
    expect(missingCouplePartners([SEAT(3), SEAT(1)], couples)).toEqual([SEAT(2), SEAT(4)]);
  });

  it('standard seats are picked on their own', () => {
    expect(missingCouplePartners([SEAT(7), SEAT(8)], [])).toEqual([]);
  });
});

describe('bookingTotals', () => {
  it('subtotal = seats + every combo line (unit price × quantity); total = subtotal − discount', () => {
    const totals = bookingTotals(
      [90_000, 90_000, 115_000],
      [
        { unitPrice: 79_000, quantity: 2 },
        { unitPrice: 45_000, quantity: 1 },
        { unitPrice: 30_000, quantity: 3 },
      ],
    );

    // 295 000 seats + 158 000 + 45 000 + 90 000 combos
    expect(totals).toEqual({ subtotal: 588_000, discount: 0, total: 588_000 });
  });

  it('seats only', () => {
    expect(bookingTotals([75_000], [])).toEqual({ subtotal: 75_000, discount: 0, total: 75_000 });
  });

  it('subtracts a discount from the subtotal (vouchers, phase 5)', () => {
    expect(bookingTotals([100_000], [{ unitPrice: 50_000, quantity: 1 }], 20_000)).toEqual({
      subtotal: 150_000,
      discount: 20_000,
      total: 130_000,
    });
  });
});

describe('bookingCode', () => {
  it('10 characters without the look-alikes 0/O and 1/I', () => {
    for (let i = 0; i < 200; i++) expect(bookingCode()).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  });
});

describe('isHoldExpired (the `expired` flag)', () => {
  const holdUntil = at('2026-11-01T10:15:00.000Z');

  it('PENDING from holdUntil on → true, even though nothing marked it EXPIRED yet', () => {
    expect(
      isHoldExpired({ status: BookingStatus.PENDING, holdUntil }, at('2026-11-01T10:14:59.999Z')),
    ).toBe(false);
    expect(isHoldExpired({ status: BookingStatus.PENDING, holdUntil }, holdUntil)).toBe(true);
    expect(
      isHoldExpired({ status: BookingStatus.PENDING, holdUntil }, at('2026-11-02T00:00:00.000Z')),
    ).toBe(true);
  });

  it('any other status → false, whatever the time (CONFIRMED stays valid; EXPIRED says it already)', () => {
    const late = at('2026-11-02T00:00:00.000Z');
    for (const status of [
      BookingStatus.CONFIRMED,
      BookingStatus.EXPIRED,
      BookingStatus.NEEDS_REVIEW,
    ]) {
      expect(isHoldExpired({ status, holdUntil }, late)).toBe(false);
    }
  });
});
