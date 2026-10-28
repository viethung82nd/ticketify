import { Logger } from '@nestjs/common';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { BookingQueueProducer } from '../../infra/queue/booking-queue.producer';
import { expireBookingJobId } from '../../infra/queue/booking-queue';
import { BookingExpirationQueue, expiryDelayMs } from './booking-expiration-queue';

const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';

describe('expiryDelayMs', () => {
  const clock = new FakeClock('2026-11-01T10:00:00.000Z');

  it('holdUntil 90 s ahead → 90 000 ms', () => {
    const holdUntil = new FakeClock('2026-11-01T10:01:30.000Z').now();
    expect(expiryDelayMs(holdUntil, clock.now())).toBe(90_000);
  });

  it('holdUntil already passed (or exactly now) → 0, never negative', () => {
    const holdUntil = clock.now();
    expect(expiryDelayMs(holdUntil, clock.now())).toBe(0);
    clock.advance({ minutes: 5 });
    expect(expiryDelayMs(holdUntil, clock.now())).toBe(0);
  });
});

describe('BookingExpirationQueue.schedule', () => {
  let clock: FakeClock;
  let enqueueExpiry: jest.Mock<Promise<void>, [string, number]>;
  let queue: BookingExpirationQueue;
  let error: jest.SpyInstance<void, [message: unknown]>;

  beforeEach(() => {
    clock = new FakeClock('2026-11-01T10:00:00.000Z');
    enqueueExpiry = jest.fn<Promise<void>, [string, number]>(() => Promise.resolve());
    queue = new BookingExpirationQueue({ enqueueExpiry } as unknown as BookingQueueProducer, clock);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined) as jest.SpyInstance<void, [message: unknown]>;
  });

  afterEach(() => error.mockRestore());

  it('enqueues the booking with the delay measured on ClockService', async () => {
    await queue.schedule(BOOKING_ID, new FakeClock('2026-11-01T10:15:00.000Z').now());

    expect(enqueueExpiry).toHaveBeenCalledWith(BOOKING_ID, 15 * 60_000);
  });

  it('never throws when Redis refuses the job: logs an error instead', async () => {
    enqueueExpiry.mockRejectedValueOnce(new Error('Connection is closed.'));

    await expect(queue.schedule(BOOKING_ID, clock.now())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(
      new RegExp(`${BOOKING_ID}.*sweep.*Connection is closed`),
    );
  });
});

describe('expireBookingJobId', () => {
  it('one fixed id per booking, without the ":" BullMQ refuses in custom ids', () => {
    expect(expireBookingJobId(BOOKING_ID)).toBe(`expire-booking-${BOOKING_ID}`);
    expect(expireBookingJobId(BOOKING_ID)).not.toContain(':');
  });
});
