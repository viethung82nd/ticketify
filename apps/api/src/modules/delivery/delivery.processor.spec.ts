import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { NotificationType } from '@ticketify/shared';
import type { AppConfig } from '../../config/app-config.service';
import { OutboxEventType, SeatsReleasedCause } from '../../infra/outbox/outbox-events';
import { DeliveryAction, type DeliveryJobData } from '../../infra/queue/delivery-queue';
import type { QueueWorkers } from '../../infra/queue/queue-workers';
import type {
  NewNotification,
  NotificationsService,
  StoredNotification,
} from '../notifications/notifications.service';
import { NotificationEvents } from '../realtime/notification-events';
import { SeatEvents } from '../realtime/seat-events';
import { RecordingTransport } from '../realtime/testing/recording-transport';
import { BookingDelivery, BookingGoneError, type DeliveryBooking } from './booking-delivery';
import { DeliveryProcessor } from './delivery.processor';

const SHOWTIME_ID = '01a3a1aa-7100-7679-b8b1-0000000000a1';
const BOOKING_ID = '01a3a1aa-7100-7679-b8b1-000000000001';
const PAYMENT_ID = '01a3a1aa-7100-7679-b8b1-0000000000b1';
const PAID_PAYMENT_ID = '01a3a1aa-7100-7679-b8b1-0000000000b2';
const EVENT_ID = '01a3a1aa-7100-7679-b8b1-0000000000f1';
const USER_ID = '01a3a1aa-7100-7679-b8b1-000000000011';
const ADMIN_ID = '01a3a1aa-7100-7679-b8b1-000000000012';
const TICKET_ID = '01a3a1aa-7100-7679-b8b1-0000000000d1';
const SEAT_A = '01a3a1aa-7100-7679-b8b1-0000000000c1';

const booking: DeliveryBooking = {
  id: BOOKING_ID,
  code: 'BK123456',
  total: 90_000,
  emailSentAt: null,
  user: { id: USER_ID, email: 'khach@test.local', fullName: 'Nguyễn Văn A' },
  movie: { title: 'Mắt Biếc' },
  showtime: {
    id: SHOWTIME_ID,
    startsAt: new Date('2026-11-05T12:30:00.000Z'),
    endsAt: new Date('2026-11-05T14:30:00.000Z'),
  },
  room: { name: 'Phòng 1' },
  seats: [{ seatId: SEAT_A, label: 'A1', type: 'STANDARD', price: 90_000 }],
  tickets: [
    {
      id: TICKET_ID,
      code: 'TKT123456789',
      seatId: SEAT_A,
      seatLabel: 'A1',
      seatType: 'STANDARD',
      status: 'ISSUED',
    },
  ],
};

const job = (
  name: DeliveryAction,
  type: OutboxEventType,
  payload: Record<string, unknown>,
): Job<DeliveryJobData> =>
  ({
    name,
    data: { eventId: EVENT_ID, type, aggregateId: BOOKING_ID, payload },
  }) as Job<DeliveryJobData>;

const seatsReleased = {
  bookingId: BOOKING_ID,
  showtimeId: SHOWTIME_ID,
  seatIds: [SEAT_A],
  cause: SeatsReleasedCause.BOOKING_EXPIRED,
};

const confirmed = {
  bookingId: BOOKING_ID,
  bookingCode: 'BK123456',
  userId: USER_ID,
  showtimeId: SHOWTIME_ID,
  paymentId: PAYMENT_ID,
  seatIds: [SEAT_A],
  ticketIds: [TICKET_ID],
  reclaimed: false,
};

const needsReview = {
  bookingId: BOOKING_ID,
  bookingCode: 'BK123456',
  userId: USER_ID,
  showtimeId: SHOWTIME_ID,
  paymentId: PAYMENT_ID,
  amount: 90_000,
  vnpTransactionNo: '14012345',
  reason: 'SEAT_SOLD',
  seatIds: [SEAT_A],
  releasedSeatIds: [],
};

const refundRequired = {
  paymentId: PAYMENT_ID,
  txnRef: 'abcdefghij1234567890',
  bookingId: BOOKING_ID,
  bookingCode: 'BK123456',
  userId: USER_ID,
  amount: 90_000,
  vnpTransactionNo: '14012345',
  paidPaymentId: PAID_PAYMENT_ID,
};

describe('DeliveryProcessor', () => {
  let transport: RecordingTransport;
  let processor: DeliveryProcessor;
  let stored: NewNotification[];
  let admins: string[];

  beforeEach(() => {
    transport = new RecordingTransport();
    stored = [];
    admins = [ADMIN_ID];
    const notifications = {
      store: jest.fn((input: NewNotification) => {
        stored.push(input);
        const rows: StoredNotification[] = input.userIds.map((userId, index) => ({
          id: `notification-${stored.length}-${index}`,
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data,
          readAt: null,
          createdAt: '2026-11-05T10:00:00.000Z',
        }));
        return Promise.resolve(rows);
      }),
      adminIds: jest.fn(() => Promise.resolve(admins)),
    } as unknown as NotificationsService;
    const bookings = {
      read: jest.fn(() => Promise.resolve(booking)),
    } as unknown as BookingDelivery;
    const config = { get: jest.fn(() => 'Asia/Ho_Chi_Minh') } as unknown as AppConfig;

    processor = new DeliveryProcessor(
      {} as QueueWorkers,
      new SeatEvents(transport),
      notifications,
      new NotificationEvents(transport),
      bookings,
      config,
    );
    jest.spyOn(processor['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(processor['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(processor['logger'], 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('broadcast-seats', () => {
    it('sends seat:released to the showtime room', async () => {
      await processor.process(
        job(DeliveryAction.BROADCAST_SEATS, OutboxEventType.SEATS_RELEASED, seatsReleased),
      );

      expect(transport.triples()).toEqual([
        [
          `showtime:${SHOWTIME_ID}`,
          'seat:released',
          { showtimeId: SHOWTIME_ID, seatIds: [SEAT_A] },
        ],
      ]);
    });

    it('gives up for good on a payload it cannot read, and sends nothing', async () => {
      await expect(
        processor.process(
          job(DeliveryAction.BROADCAST_SEATS, OutboxEventType.SEATS_RELEASED, {
            showtimeId: 'not-a-uuid',
          }),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(transport.sent).toEqual([]);
    });
  });

  describe('notify', () => {
    it('a confirmed booking: one notification for the user, pushed to their room', async () => {
      await processor.process(
        job(DeliveryAction.NOTIFY, OutboxEventType.BOOKING_CONFIRMED, confirmed),
      );

      expect(stored).toEqual([
        expect.objectContaining({
          userIds: [USER_ID],
          type: NotificationType.BOOKING_CONFIRMED,
          eventId: EVENT_ID,
        }),
      ]);
      expect(stored[0]?.title).toBe('Đơn BK123456 đã được xác nhận');
      // 12:30 UTC is 19:30 in Vietnam.
      expect(stored[0]?.body).toContain('19:30 ngày 05/11/2026');
      expect(stored[0]?.body).toContain('Ghế A1');
      expect(transport.sent.map((event) => [event.room, event.event])).toEqual([
        [`user:${USER_ID}`, 'notification:new'],
      ]);
    });

    it('a booking under review: an apology to the user and a task for every admin', async () => {
      admins = [ADMIN_ID, USER_ID];

      await processor.process(
        job(DeliveryAction.NOTIFY, OutboxEventType.BOOKING_NEEDS_REVIEW, needsReview),
      );

      expect(stored.map((input) => input.userIds)).toEqual([[USER_ID], [ADMIN_ID, USER_ID]]);
      expect(stored[0]?.title).toBe('Đơn BK123456 cần được xem lại');
      expect(stored[0]?.body).toContain('có ghế đã được bán cho đơn khác');
      expect(stored[0]?.body).toContain('90.000 đ');
      expect(stored[1]?.title).toBe('Cần xử lý tay: đơn BK123456 (SEAT_SOLD)');
      expect(stored[1]?.body).toContain('khach@test.local');
      // The user is told once, as a user: the apology comes first and the index keeps the rest out.
      expect(stored[0]?.eventId).toBe(stored[1]?.eventId);
    });

    it('a double payment: admins only, never the user who owes nothing', async () => {
      await processor.process(
        job(DeliveryAction.NOTIFY, OutboxEventType.PAYMENT_REFUND_REQUIRED, refundRequired),
      );

      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        userIds: [ADMIN_ID],
        type: NotificationType.PAYMENT_REFUND_REQUIRED,
      });
      expect(stored[0]?.title).toContain('Cần hoàn tiền');
      expect(stored[0]?.body).toContain('14012345');
    });

    it('pushes nothing for a notification that was already stored', async () => {
      const notifications = processor['notifications'];
      jest.spyOn(notifications, 'store').mockResolvedValue([]);

      await processor.process(
        job(DeliveryAction.NOTIFY, OutboxEventType.BOOKING_CONFIRMED, confirmed),
      );

      expect(transport.sent).toEqual([]);
    });

    it('drops the event when the booking is gone instead of retrying forever', async () => {
      jest.spyOn(processor['bookings'], 'read').mockRejectedValue(new BookingGoneError(BOOKING_ID));

      await expect(
        processor.process(job(DeliveryAction.NOTIFY, OutboxEventType.BOOKING_CONFIRMED, confirmed)),
      ).resolves.toBeUndefined();

      expect(stored).toEqual([]);
      expect(transport.sent).toEqual([]);
    });

    it('gives up for good on an event type it has no notification for', async () => {
      await expect(
        processor.process(
          job(DeliveryAction.NOTIFY, OutboxEventType.SEATS_RELEASED, seatsReleased),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });

  it('gives up for good on an action it does not know', async () => {
    await expect(
      processor.process(
        job('dance' as DeliveryAction, OutboxEventType.SEATS_RELEASED, seatsReleased),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
