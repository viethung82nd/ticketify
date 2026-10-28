import { Logger } from '@nestjs/common';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { BookingQueueProducer } from '../../infra/queue/booking-queue.producer';
import type { QueueWorkers } from '../../infra/queue/queue-workers';
import { BookingExpiryProcessor } from './booking-expiry.processor';
import type { BookingExpiryService } from './booking-expiry.service';
import type { ExpireOutcome } from './expire-booking';

const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';

function setup(outcome: ExpireOutcome) {
  const expire = jest.fn(() => Promise.resolve(outcome));
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
    const { processor, expire, job } = setup({ outcome: 'expired', releasedSeats: 2 });

    await expect(processor.process(job, 'token')).resolves.toEqual({
      outcome: 'expired',
      releasedSeats: 2,
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

  it('an unknown job name is not retried', async () => {
    const { processor } = setup({ outcome: 'noop' });

    await expect(
      processor.process({ name: 'nope', data: {} } as unknown as Job, 'token'),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
