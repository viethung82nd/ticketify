import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { OutboxEventType, SeatsReleasedCause } from '../../infra/outbox/outbox-events';
import { DeliveryAction, type DeliveryJobData } from '../../infra/queue/delivery-queue';
import type { QueueWorkers } from '../../infra/queue/queue-workers';
import { SeatEvents, type SeatEventName, type SeatEventPayload } from '../realtime/seat-events';
import { DeliveryProcessor } from './delivery.processor';

const SHOWTIME_ID = '01a3a1aa-7100-7679-b8b1-0000000000a1';
const BOOKING_ID = '01a3a1aa-7100-7679-b8b1-000000000001';
const SEAT_A = '01a3a1aa-7100-7679-b8b1-0000000000c1';

class RecordingSeatEvents extends SeatEvents {
  readonly sent: { room: string; event: SeatEventName; payload: SeatEventPayload }[] = [];

  protected emit(room: string, event: SeatEventName, payload: SeatEventPayload): void {
    this.sent.push({ room, event, payload });
  }
}

const job = (name: DeliveryAction, payload: Record<string, unknown>): Job<DeliveryJobData> =>
  ({
    name,
    data: {
      eventId: '01a3a1aa-7100-7679-b8b1-0000000000f1',
      type: OutboxEventType.SEATS_RELEASED,
      aggregateId: BOOKING_ID,
      payload,
    },
  }) as Job<DeliveryJobData>;

const seatsReleased = {
  bookingId: BOOKING_ID,
  showtimeId: SHOWTIME_ID,
  seatIds: [SEAT_A],
  cause: SeatsReleasedCause.BOOKING_EXPIRED,
};

describe('DeliveryProcessor', () => {
  let seatEvents: RecordingSeatEvents;
  let processor: DeliveryProcessor;

  beforeEach(() => {
    seatEvents = new RecordingSeatEvents();
    processor = new DeliveryProcessor({} as QueueWorkers, seatEvents);
    jest.spyOn(processor['logger'], 'error').mockImplementation(() => undefined);
  });

  it('broadcast-seats sends seat:released to the showtime room', async () => {
    await processor.process(job(DeliveryAction.BROADCAST_SEATS, seatsReleased));

    expect(seatEvents.sent).toEqual([
      {
        room: `showtime:${SHOWTIME_ID}`,
        event: 'seat:released',
        payload: { showtimeId: SHOWTIME_ID, seatIds: [SEAT_A] },
      },
    ]);
  });

  it('gives up for good on a payload it cannot read, and sends nothing', async () => {
    await expect(
      processor.process(job(DeliveryAction.BROADCAST_SEATS, { showtimeId: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(seatEvents.sent).toEqual([]);
  });

  it('gives up for good on an action it does not know', async () => {
    await expect(
      processor.process(job('dance' as DeliveryAction, seatsReleased)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
