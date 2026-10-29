import { ShowtimeSeatStatus, ShowtimeStatus } from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import {
  type BookingSeatState,
  heldSeatsProblem,
  isReclaimable,
  reclaimProblem,
  ReviewReason,
  showtimeProblem,
  TicketCodes,
} from './seat-settlement';

const at = (iso: string): Date => new FakeClock(iso).now();
const NOW = at('2026-11-01T10:20:00.000Z');
const PAST = at('2026-11-01T10:15:00.000Z');
const FUTURE = at('2026-11-01T10:30:00.000Z');
const BOOKING = '01a17e75-7100-7679-b8b1-000000000001';
const OTHER = '01a17e75-7100-7679-b8b1-000000000002';

const available = (seatId: string): BookingSeatState => ({
  seatId,
  status: ShowtimeSeatStatus.AVAILABLE,
  bookingId: null,
  heldUntil: null,
});
const held = (seatId: string, bookingId: string, heldUntil: Date): BookingSeatState => ({
  seatId,
  status: ShowtimeSeatStatus.HELD,
  bookingId,
  heldUntil,
});
const sold = (seatId: string, bookingId: string): BookingSeatState => ({
  seatId,
  status: ShowtimeSeatStatus.SOLD,
  bookingId,
  heldUntil: null,
});

describe('heldSeatsProblem (branch A: PENDING booking)', () => {
  it('null when every seat is HELD by the booking, even past heldUntil', () => {
    expect(heldSeatsProblem([held('a', BOOKING, FUTURE), held('b', BOOKING, PAST)], BOOKING)).toBe(
      null,
    );
  });

  it.each([
    ['SOLD to another booking', sold('b', OTHER), ReviewReason.SEAT_SOLD],
    ['HELD by another booking (live)', held('b', OTHER, FUTURE), ReviewReason.SEAT_HELD_BY_OTHER],
    ['HELD by another booking (expired)', held('b', OTHER, PAST), ReviewReason.SEAT_HELD_BY_OTHER],
    ['AVAILABLE', available('b'), ReviewReason.SEAT_RELEASED],
  ])('one seat %s → %s', (_label, seat, reason) => {
    expect(heldSeatsProblem([held('a', BOOKING, FUTURE), seat], BOOKING)).toEqual({
      reason,
      seatIds: ['b'],
    });
  });

  it('several failing seats: the most serious reason, every failing seat sorted', () => {
    const seats = [
      available('d'),
      held('c', OTHER, FUTURE),
      sold('b', OTHER),
      held('a', BOOKING, FUTURE),
    ];
    expect(heldSeatsProblem(seats, BOOKING)).toEqual({
      reason: ReviewReason.SEAT_SOLD,
      seatIds: ['b', 'c', 'd'],
    });
  });

  it('a booking without seats is never confirmed', () => {
    expect(heldSeatsProblem([], BOOKING)).toEqual({ reason: ReviewReason.NO_SEATS, seatIds: [] });
  });
});

describe('isReclaimable / reclaimProblem (branch B: EXPIRED booking)', () => {
  it.each([
    ['AVAILABLE', available('a'), true],
    ['HELD by the booking itself', held('a', BOOKING, PAST), true],
    ['HELD by another booking past heldUntil', held('a', OTHER, PAST), true],
    ['HELD by another booking exactly at heldUntil', held('a', OTHER, NOW), true],
    ['HELD by another booking, live', held('a', OTHER, FUTURE), false],
    ['SOLD to another booking', sold('a', OTHER), false],
  ])('%s → %s', (_label, seat, expected) => {
    expect(isReclaimable(seat, BOOKING, NOW)).toBe(expected);
  });

  it('null when every seat can be taken back', () => {
    expect(reclaimProblem([available('a'), held('b', OTHER, PAST)], BOOKING, NOW)).toBe(null);
  });

  it('one SOLD seat → SEAT_SOLD (all or nothing: the free seat does not make it through)', () => {
    expect(reclaimProblem([available('a'), sold('b', OTHER)], BOOKING, NOW)).toEqual({
      reason: ReviewReason.SEAT_SOLD,
      seatIds: ['b'],
    });
  });

  it('one seat held by a live booking → SEAT_HELD_BY_OTHER', () => {
    expect(reclaimProblem([available('a'), held('b', OTHER, FUTURE)], BOOKING, NOW)).toEqual({
      reason: ReviewReason.SEAT_HELD_BY_OTHER,
      seatIds: ['b'],
    });
  });

  it('SOLD outranks HELD', () => {
    expect(reclaimProblem([held('a', OTHER, FUTURE), sold('b', OTHER)], BOOKING, NOW)).toEqual({
      reason: ReviewReason.SEAT_SOLD,
      seatIds: ['a', 'b'],
    });
  });

  it('a booking without seats is never reclaimed', () => {
    expect(reclaimProblem([], BOOKING, NOW)).toEqual({
      reason: ReviewReason.NO_SEATS,
      seatIds: [],
    });
  });
});

describe('showtimeProblem', () => {
  const showtime = (status: ShowtimeStatus, endsAt: Date) => ({ status, endsAt });

  it('null while the showtime runs or has not started: late entry is allowed', () => {
    expect(showtimeProblem(showtime(ShowtimeStatus.SCHEDULED, FUTURE), NOW)).toBe(null);
  });

  it('SHOWTIME_ENDED once endsAt has passed, and exactly at endsAt', () => {
    expect(showtimeProblem(showtime(ShowtimeStatus.SCHEDULED, PAST), NOW)).toEqual({
      reason: ReviewReason.SHOWTIME_ENDED,
      seatIds: [],
    });
    expect(showtimeProblem(showtime(ShowtimeStatus.SCHEDULED, NOW), NOW)?.reason).toBe(
      ReviewReason.SHOWTIME_ENDED,
    );
  });

  it('SHOWTIME_CANCELLED first, ended or not', () => {
    for (const endsAt of [PAST, FUTURE]) {
      expect(showtimeProblem(showtime(ShowtimeStatus.CANCELLED, endsAt), NOW)?.reason).toBe(
        ReviewReason.SHOWTIME_CANCELLED,
      );
    }
  });
});

describe('TicketCodes', () => {
  it('12 characters without 0/O/1/I, different each draw', () => {
    const codes = new TicketCodes();
    const drawn = Array.from({ length: 200 }, () => codes.next());
    for (const code of drawn) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    expect(new Set(drawn).size).toBe(drawn.length);
  });
});
