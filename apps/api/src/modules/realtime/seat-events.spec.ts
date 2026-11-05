import { Logger } from '@nestjs/common';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { SeatEvents } from './seat-events';
import { RecordingTransport } from './testing/recording-transport';

const SHOWTIME = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT = '01a17e75-7100-7679-b8b1-0000000000c1';

describe('SeatEvents', () => {
  let warn: jest.SpyInstance;
  let transport: RecordingTransport;
  let events: SeatEvents;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    transport = new RecordingTransport();
    events = new SeatEvents(transport);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends each event to room showtime:{id} with only the changed seats', () => {
    const heldUntil = new FakeClock('2026-11-01T10:15:00.000Z').now();

    events.held(SHOWTIME, [SEAT], heldUntil);
    events.released(SHOWTIME, [SEAT]);
    events.sold(SHOWTIME, [SEAT]);

    const room = `showtime:${SHOWTIME}`;
    expect(transport.triples()).toEqual([
      [
        room,
        'seat:held',
        { showtimeId: SHOWTIME, seatIds: [SEAT], heldUntil: '2026-11-01T10:15:00.000Z' },
      ],
      [room, 'seat:released', { showtimeId: SHOWTIME, seatIds: [SEAT] }],
      [room, 'seat:sold', { showtimeId: SHOWTIME, seatIds: [SEAT] }],
    ]);
  });

  it('sends nothing when no seat changed', () => {
    events.released(SHOWTIME, []);

    expect(transport.sent).toEqual([]);
  });

  it('never throws: a failed emit is a warning (best-effort)', () => {
    transport.failWith = new Error('Redis down');

    expect(() => events.released(SHOWTIME, [SEAT])).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('seat:released not sent'));
  });
});
