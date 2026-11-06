import { Logger } from '@nestjs/common';
import type { Notification } from '@ticketify/shared';
import { NotificationEvents } from './notification-events';
import { RecordingTransport } from './testing/recording-transport';

const USER = '01a17e75-7100-7679-b8b1-000000000011';

const notification: Notification = {
  id: '01a17e75-7100-7679-b8b1-0000000000e1',
  type: 'BOOKING_CONFIRMED',
  title: 'Đơn BK1 đã được xác nhận',
  body: 'Vé của bạn đã sẵn sàng.',
  data: { bookingId: '01a17e75-7100-7679-b8b1-000000000001' },
  readAt: null,
  createdAt: '2026-11-05T10:00:00.000Z',
};

describe('NotificationEvents', () => {
  let warn: jest.SpyInstance;
  let transport: RecordingTransport;
  let events: NotificationEvents;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    transport = new RecordingTransport();
    events = new NotificationEvents(transport);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the notification to room user:{id} only', () => {
    events.created(USER, notification);

    expect(transport.triples()).toEqual([[`user:${USER}`, 'notification:new', notification]]);
  });

  it('never throws: a failed emit is a warning (best-effort)', () => {
    transport.failWith = new Error('Redis down');

    expect(() => events.created(USER, notification)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notification:new not sent'));
  });
});
