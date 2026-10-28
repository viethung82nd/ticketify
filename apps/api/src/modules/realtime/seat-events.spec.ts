import { Logger } from '@nestjs/common';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { SeatEvents, type SeatEventName, type SeatEventPayload } from './seat-events';

const SHOWTIME = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT = '01a17e75-7100-7679-b8b1-0000000000c1';

class RecordingSeatEvents extends SeatEvents {
  readonly sent: [string, SeatEventName, SeatEventPayload][] = [];
  failWith: Error | null = null;

  protected emit(room: string, event: SeatEventName, payload: SeatEventPayload): void {
    if (this.failWith) throw this.failWith;
    this.sent.push([room, event, payload]);
  }
}

describe('SeatEvents', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends each event to room showtime:{id} with only the changed seats', () => {
    const events = new RecordingSeatEvents();
    const heldUntil = new FakeClock('2026-11-01T10:15:00.000Z').now();

    events.held(SHOWTIME, [SEAT], heldUntil);
    events.released(SHOWTIME, [SEAT]);
    events.sold(SHOWTIME, [SEAT]);

    const room = `showtime:${SHOWTIME}`;
    expect(events.sent).toEqual([
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
    const events = new RecordingSeatEvents();

    events.released(SHOWTIME, []);

    expect(events.sent).toEqual([]);
  });

  it('never throws: a failed emit is a warning (best-effort)', () => {
    const events = new RecordingSeatEvents();
    events.failWith = new Error('Redis down');

    expect(() => events.released(SHOWTIME, [SEAT])).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('seat:released not sent'));
  });
});
