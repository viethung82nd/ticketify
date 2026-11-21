import { PublicSeatStatus } from '@ticketify/shared';
import { describe, expect, it } from 'vitest';
import { seat, seatsFrom } from '@/test/seat-fixtures';
import {
  applySeatEvent,
  dropTaken,
  groupOf,
  isSelectable,
  SEATS_MAX,
  seatAriaLabel,
  takenMessage,
  toggleSeat,
} from './seat-selection';

// A1–A8 standard with A3 held, A4 sold, A5 not sold; B1–B4 VIP; C1–C4 two couple pairs.
const ROOM = seatsFrom(['..hsx...', 'VVVV', 'CCCC']);
const at = (label: string) => seat(ROOM, label);

describe('isSelectable', () => {
  it('only an AVAILABLE seat with a price', () => {
    expect(isSelectable(at('A1'))).toBe(true);
    expect(isSelectable(at('A3'))).toBe(false);
    expect(isSelectable(at('A4'))).toBe(false);
    expect(isSelectable(at('A5'))).toBe(false);
  });
});

describe('groupOf', () => {
  it('a couple seat comes with its partner, in seat order, from either side', () => {
    expect(groupOf(ROOM, at('C2')).map((s) => s.label)).toEqual(['C1', 'C2']);
    expect(groupOf(ROOM, at('C3')).map((s) => s.label)).toEqual(['C3', 'C4']);
  });

  it('any other seat is alone', () => {
    expect(groupOf(ROOM, at('B2'))).toEqual([at('B2')]);
  });
});

describe('toggleSeat', () => {
  it('selects a free seat and says how many are chosen', () => {
    const result = toggleSeat(ROOM, [], at('A1'));

    expect(result).toEqual({
      selected: ['seat-A1'],
      message: `Đã chọn ghế A1. Đang chọn 1/${SEATS_MAX} ghế.`,
      refused: false,
    });
  });

  it('a second click on the seat unselects it', () => {
    expect(toggleSeat(ROOM, ['seat-A1', 'seat-A2'], at('A1'))).toMatchObject({
      selected: ['seat-A2'],
      message: `Đã bỏ chọn ghế A1. Đang chọn 1/${SEATS_MAX} ghế.`,
      refused: false,
    });
  });

  it('a couple seat selects and unselects both seats of the pair', () => {
    const on = toggleSeat(ROOM, [], at('C2'));
    expect(on).toMatchObject({
      selected: ['seat-C1', 'seat-C2'],
      message: `Đã chọn ghế đôi C1–C2. Đang chọn 2/${SEATS_MAX} ghế.`,
    });
    expect(toggleSeat(ROOM, on.selected, at('C1')).selected).toEqual([]);
  });

  it.each([
    ['A3', 'Ghế A3 đang giữ, không chọn được.'],
    ['A4', 'Ghế A4 đã bán, không chọn được.'],
    ['A5', 'Ghế A5 không bán, không chọn được.'],
  ])('refuses %s and keeps the selection as it was', (label, message) => {
    expect(toggleSeat(ROOM, ['seat-A1'], at(label))).toEqual({
      selected: ['seat-A1'],
      message,
      refused: true,
    });
  });

  it('refuses a couple seat whose partner cannot be taken, naming the partner', () => {
    const room = seatsFrom(['Cs']);
    // The sold partner keeps the couple type; mark it COUPLE in the same group.
    const pair = room.map((s) => ({ ...s, type: room[0]!.type, coupleGroup: 1 }));

    expect(toggleSeat(pair, [], seat(pair, 'A1'))).toMatchObject({
      refused: true,
      message: 'Không chọn được ghế đôi A1–A2: ghế A2 đã bán.',
    });
  });

  it(`never goes past ${SEATS_MAX} seats, a pair included`, () => {
    const five = ['seat-A1', 'seat-A2', 'seat-A6', 'seat-A7', 'seat-A8'];
    expect(toggleSeat(ROOM, five, at('B1')).selected).toHaveLength(SEATS_MAX);
    expect(toggleSeat(ROOM, [...five, 'seat-B1'], at('B2'))).toMatchObject({
      refused: true,
      message: `Mỗi đơn tối đa ${SEATS_MAX} ghế. Bỏ bớt ghế trước khi chọn ghế B2.`,
    });
    expect(toggleSeat(ROOM, five, at('C1'))).toMatchObject({
      refused: true,
      selected: five,
    });
  });
});

describe('dropTaken', () => {
  it('removes the taken seats and the partner of a taken couple seat', () => {
    const selected = ['seat-A1', 'seat-C1', 'seat-C2'];

    expect(dropTaken(ROOM, selected, ['seat-C2', 'seat-B1'])).toEqual({
      selected: ['seat-A1'],
      dropped: ['C1', 'C2'],
    });
    expect(takenMessage(['C1', 'C2'])).toBe(
      'Ghế C1, C2 vừa có người chọn. Ghế đã được bỏ khỏi lựa chọn của bạn.',
    );
  });

  it('changes nothing when none of the taken seats was selected', () => {
    expect(dropTaken(ROOM, ['seat-A1'], ['seat-A2'])).toEqual({
      selected: ['seat-A1'],
      dropped: [],
    });
  });
});

describe('seatAriaLabel', () => {
  it('row, number, type, partner, status and whether it is chosen', () => {
    expect(seatAriaLabel(ROOM, at('B2'), false)).toBe('Hàng B, ghế 2, VIP, còn trống, chưa chọn');
    expect(seatAriaLabel(ROOM, at('C1'), true)).toBe(
      'Hàng C, ghế 1, Đôi, ghép với C2, còn trống, đang chọn',
    );
    expect(seatAriaLabel(ROOM, at('A5'), false)).toBe(
      'Hàng A, ghế 5, Thường, không bán, chưa chọn',
    );
  });
});

describe('applySeatEvent', () => {
  const map = { showtime: {} as never, seats: ROOM };

  it('changes only the listed seats', () => {
    const { map: next, mismatch } = applySeatEvent(map, ['seat-A1'], PublicSeatStatus.HELD);

    expect(mismatch).toBe(false);
    expect(seat(next.seats, 'A1').status).toBe(PublicSeatStatus.HELD);
    expect(seat(next.seats, 'A2').status).toBe(PublicSeatStatus.AVAILABLE);
  });

  it('asks for a reload when the event does not fit what the map shows', () => {
    // Held again, sold → available, a seat not on the map, a seat that is not sold.
    expect(applySeatEvent(map, ['seat-A3'], PublicSeatStatus.HELD).mismatch).toBe(true);
    expect(applySeatEvent(map, ['seat-A4'], PublicSeatStatus.AVAILABLE).mismatch).toBe(true);
    expect(applySeatEvent(map, ['seat-Z9'], PublicSeatStatus.SOLD).mismatch).toBe(true);
    expect(applySeatEvent(map, ['seat-A5'], PublicSeatStatus.HELD).mismatch).toBe(true);
  });

  it('a release of a seat already shown free is expected (its hold had lapsed)', () => {
    expect(applySeatEvent(map, ['seat-A1'], PublicSeatStatus.AVAILABLE).mismatch).toBe(false);
  });
});
