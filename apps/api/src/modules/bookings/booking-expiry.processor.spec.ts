import { Logger } from '@nestjs/common';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { BookingQueueProducer } from '../../infra/queue/booking-queue.producer';
import type { QueueWorkers } from '../../infra/queue/queue-workers';
import { BookingExpiryProcessor } from './booking-expiry.processor';
import type { BookingExpiryService } from './booking-expiry.service';
import type { ExpireOutcome } from './expire-booking';

const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_ID = '01a17e75-7100-7679-b8b1-0000000000c1';
const EXPIRED: ExpireOutcome = {
  outcome: 'expired',
  showtimeId: SHOWTIME_ID,
  releasedSeatIds: [SEAT_ID],
};

/** What Prisma throws when `lock_timeout` ends a wait (driver-adapter error, SQLSTATE 55P03). */
const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), {
  meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
});

function setup(outcome: ExpireOutcome | Error) {
  const expire = jest.fn(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
  );
  const processor = new BookingExpiryProcessor(
    { expire } as unknown as BookingExpiryService,
    {} as QueueWorkers,
    {} as BookingQueueProducer,
    0,
  );
  const moveToDelayed = jest.fn(() => Promise.resolve());
  const job = { name: 'expire-booking', data: { bookingId: BOOKING_ID }, moveToDelayed };
  return { processor, expire, moveToDelayed, job: job as unknown as Job };
}

describe('BookingExpiryProcessor (expire-booking job)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('returns the outcome of expireBooking for the booking of the job', async () => {
    const { processor, expire, job } = setup(EXPIRED);

    await expect(processor.process(job, 'token')).resolves.toEqual({
      outcome: 'expired',
      showtimeId: SHOWTIME_ID,
      releasedSeatIds: [SEAT_ID],
    });
    expect(expire).toHaveBeenCalledWith(BOOKING_ID);
  });

  it.each<ExpireOutcome>([{ outcome: 'noop' }, { outcome: 'skipped' }])(
    '%o completes the job: nothing left to do',
    async (outcome) => {
      const { processor, job, moveToDelayed } = setup(outcome);

      await expect(processor.process(job, 'token')).resolves.toEqual(outcome);
      expect(moveToDelayed).not.toHaveBeenCalled();
    },
  );

  it('early: the same job is delayed again until holdUntil (DelayedError, no attempt used)', async () => {
    const holdUntil = new FakeClock('2026-11-01T10:15:00.000Z').now();
    const { processor, job, moveToDelayed } = setup({ outcome: 'early', holdUntil });

    await expect(processor.process(job, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(holdUntil.getTime(), 'token');
  });

  it('seats locked past the lock timeout: a plain Error, so BullMQ retries with its backoff', async () => {
    const { processor, job, moveToDelayed } = setup(lockTimeout);

    const error = await processor.process(job, 'token').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error).not.toBeInstanceOf(DelayedError);
    expect((error as Error).message).toMatch(new RegExp(`Booking ${BOOKING_ID} busy`));
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('any other error is rethrown as is', async () => {
    const boom = new Error('boom');
    const { processor, job } = setup(boom);

    await expect(processor.process(job, 'token')).rejects.toBe(boom);
  });

  it('an unknown job name is not retried', async () => {
    const { processor } = setup({ outcome: 'noop' });

    await expect(
      processor.process({ name: 'nope', data: {} } as unknown as Job, 'token'),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
