import { PublicSeatStatus, ShowtimeErrorCode, ShowtimeSeatStatus } from '@ticketify/shared';
import { asyncHttpErrorOf, httpErrorOf } from '../../common/errors/testing/http-error';
import { testConfig } from '../../config/testing/test-config';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { FakeHolidayCalendar } from '../pricing/testing/fake-holiday-calendar';
import {
  assertStartsInFuture,
  cancelDecision,
  publicSeatStatus,
  showtimeEndsAt,
} from './showtime-rules';
import { ShowtimesService } from './showtimes.service';

const instant = (iso: string): Date => new FakeClock(iso).now();
const NOW = instant('2026-11-01T10:00:00Z');

describe('showtimeEndsAt = startsAt + duration + cleaning', () => {
  it('adds the film and the cleaning time', () => {
    expect(showtimeEndsAt(instant('2026-11-02T12:30:00Z'), 120, 15)).toEqual(
      instant('2026-11-02T14:45:00Z'),
    );
  });

  it('with 0 minutes of cleaning, ends right when the film ends', () => {
    expect(showtimeEndsAt(instant('2026-11-02T12:30:00Z'), 120, 0)).toEqual(
      instant('2026-11-02T14:30:00Z'),
    );
  });

  it('a 1-minute film with no cleaning still has a positive range', () => {
    const startsAt = instant('2026-11-02T12:30:00Z');
    const endsAt = showtimeEndsAt(startsAt, 1, 0);

    expect(endsAt).toEqual(instant('2026-11-02T12:31:00Z'));
    expect(endsAt.getTime()).toBeGreaterThan(startsAt.getTime());
  });

  it('keeps seconds and milliseconds of the start', () => {
    expect(showtimeEndsAt(instant('2026-11-02T12:30:05.250Z'), 1, 15)).toEqual(
      instant('2026-11-02T12:46:05.250Z'),
    );
  });
});

describe('cinemaDayRange (CINEMA_TZ = Asia/Ho_Chi_Minh, UTC+7)', () => {
  const pricing = new PricingService(testConfig(), new FakeHolidayCalendar(), {} as PrismaService);

  it('2026-11-02 starts at 2026-11-01T17:00:00Z and ends before 2026-11-02T17:00:00Z', () => {
    const { from, to } = pricing.cinemaDayRange('2026-11-02');

    expect(from.toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });

  it('is not the UTC day: 23:30 local on 2026-11-02 (16:30Z) is inside, 00:30 local next day is not', () => {
    const { from, to } = pricing.cinemaDayRange('2026-11-02');
    const inside = instant('2026-11-02T16:30:00Z');
    const nextDay = instant('2026-11-02T17:30:00Z');
    const utcMidnightBefore = instant('2026-11-01T23:00:00Z'); // 06:00 local on the 2nd

    expect(inside >= from && inside < to).toBe(true);
    expect(nextDay >= from && nextDay < to).toBe(false);
    expect(utcMidnightBefore >= from && utcMidnightBefore < to).toBe(true);
  });

  it('crosses months and years', () => {
    expect(pricing.cinemaDayRange('2027-01-01').from.toISOString()).toBe(
      '2026-12-31T17:00:00.000Z',
    );
    expect(pricing.cinemaDayRange('2026-11-30').to.toISOString()).toBe('2026-11-30T17:00:00.000Z');
  });

  it('follows the configured zone (UTC)', () => {
    const utc = new PricingService(
      testConfig({ CINEMA_TZ: 'UTC' }),
      new FakeHolidayCalendar(),
      {} as PrismaService,
    );
    expect(utc.cinemaDayRange('2026-11-02').from.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('publicSeatStatus (lazy expiry, read-only)', () => {
  const seat = (status: ShowtimeSeatStatus, heldUntil: string | null, isActive = true) => ({
    showtimeSeat: { status, heldUntil: heldUntil === null ? null : instant(heldUntil) },
    isActive,
  });

  it('a seat without a ShowtimeSeat row (off when the showtime was created) is UNAVAILABLE', () => {
    expect(publicSeatStatus({ showtimeSeat: null, isActive: false }, NOW)).toBe(
      PublicSeatStatus.UNAVAILABLE,
    );
    // Even if it was switched back on later: it is not sold for this showtime.
    expect(publicSeatStatus({ showtimeSeat: null, isActive: true }, NOW)).toBe(
      PublicSeatStatus.UNAVAILABLE,
    );
  });

  it('an expired HELD seat is AVAILABLE', () => {
    expect(publicSeatStatus(seat('HELD', '2026-11-01T09:59:59Z'), NOW)).toBe(
      PublicSeatStatus.AVAILABLE,
    );
  });

  it('a hold ending exactly now has expired (heldUntil <= now)', () => {
    expect(publicSeatStatus(seat('HELD', '2026-11-01T10:00:00Z'), NOW)).toBe(
      PublicSeatStatus.AVAILABLE,
    );
  });

  it('a live hold stays HELD', () => {
    expect(publicSeatStatus(seat('HELD', '2026-11-01T10:00:00.001Z'), NOW)).toBe(
      PublicSeatStatus.HELD,
    );
  });

  it('AVAILABLE and SOLD are shown as they are', () => {
    expect(publicSeatStatus(seat('AVAILABLE', null), NOW)).toBe(PublicSeatStatus.AVAILABLE);
    expect(publicSeatStatus(seat('SOLD', null), NOW)).toBe(PublicSeatStatus.SOLD);
  });

  it('a seat switched off after creation is UNAVAILABLE, never AVAILABLE, whatever its row says', () => {
    expect(publicSeatStatus(seat('AVAILABLE', null, false), NOW)).toBe(
      PublicSeatStatus.UNAVAILABLE,
    );
    expect(publicSeatStatus(seat('HELD', '2026-11-01T09:00:00Z', false), NOW)).toBe(
      PublicSeatStatus.UNAVAILABLE,
    );
  });
});

describe('cancelDecision', () => {
  const upcoming = { status: 'SCHEDULED' as const, startsAt: instant('2026-11-01T12:00:00Z') };
  const none = { held: 0, sold: 0 };

  it('cancels an upcoming showtime without held or sold seats', () => {
    expect(cancelDecision(upcoming, none, NOW)).toEqual({ action: 'cancel' });
  });

  it('refuses a showtime that has started (startsAt <= now), even with no bookings', () => {
    expect(cancelDecision({ ...upcoming, startsAt: NOW }, none, NOW)).toEqual({
      action: 'reject',
      code: ShowtimeErrorCode.SHOWTIME_STARTED,
    });
  });

  it.each([
    ['a HELD seat', { held: 1, sold: 0 }],
    ['a SOLD seat', { held: 0, sold: 1 }],
    ['both', { held: 2, sold: 3 }],
  ])('refuses with %s', (_label, seats) => {
    expect(cancelDecision(upcoming, seats, NOW)).toEqual({
      action: 'reject',
      code: ShowtimeErrorCode.SHOWTIME_HAS_BOOKINGS,
    });
  });

  it('cancelling a second time is a no-op, even after the start or with bookings', () => {
    const cancelled = { ...upcoming, status: 'CANCELLED' as const };

    expect(cancelDecision(cancelled, none, NOW)).toEqual({ action: 'none' });
    expect(cancelDecision({ ...cancelled, startsAt: NOW }, { held: 1, sold: 1 }, NOW)).toEqual({
      action: 'none',
    });
  });
});

describe('startsAt must be in the future (400 VALIDATION_FAILED)', () => {
  it.each([
    ['in the past', '2026-11-01T09:00:00Z'],
    ['exactly now', '2026-11-01T10:00:00Z'],
  ])('refuses a start %s', (_label, startsAt) => {
    const error = httpErrorOf(() => assertStartsInFuture(instant(startsAt), NOW));

    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual([{ field: 'startsAt', messages: [expect.any(String)] }]);
  });

  it('accepts one millisecond after now', () => {
    expect(() => assertStartsInFuture(instant('2026-11-01T10:00:00.001Z'), NOW)).not.toThrow();
  });

  it('ShowtimesService.create refuses a past start before touching the database', async () => {
    const config = testConfig();
    const clock = new FakeClock(NOW);
    const untouched = new Proxy({} as PrismaService, {
      get: () => {
        throw new Error('the database must not be used');
      },
    });
    const pricing = new PricingService(config, new FakeHolidayCalendar(), untouched);
    const service = new ShowtimesService(untouched, clock, pricing, config);

    const error = await asyncHttpErrorOf(
      service.create({
        movieId: '01a17e75-0000-7000-8000-000000000001',
        roomId: '01a17e75-0000-7000-8000-000000000002',
        startsAt: '2026-11-01T16:59:00+07:00', // 09:59Z, one minute ago
      }),
    );
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});
