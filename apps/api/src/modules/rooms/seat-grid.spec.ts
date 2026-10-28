import { rowIndex, rowLabel } from '@ticketify/shared';
import { buildSeatGrid } from './seat-grid';

describe('buildSeatGrid', () => {
  it('creates rows × cols seats, labelled A… from the front and numbered 1…cols', () => {
    const seats = buildSeatGrid(10, 12);

    expect(seats).toHaveLength(120);
    expect([...new Set(seats.map((seat) => seat.row))]).toEqual([...'ABCDEFGHIJ']);
    expect(seats.filter((seat) => seat.row === 'C').map((seat) => seat.number)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(seats[0]).toEqual({
      row: 'A',
      number: 1,
      type: 'STANDARD',
      isActive: true,
      coupleGroup: null,
    });
  });

  it('every seat is STANDARD, active and unpaired', () => {
    const seats = buildSeatGrid(3, 4);

    expect(seats.every((seat) => seat.type === 'STANDARD')).toBe(true);
    expect(seats.every((seat) => seat.isActive)).toBe(true);
    expect(seats.every((seat) => seat.coupleGroup === null)).toBe(true);
    expect(new Set(seats.map((seat) => `${seat.row}${seat.number}`)).size).toBe(12);
  });

  it('supports the limits: 1×1 and 26×30 (rows A–Z)', () => {
    expect(buildSeatGrid(1, 1)).toHaveLength(1);
    const largest = buildSeatGrid(26, 30);
    expect(largest).toHaveLength(780);
    expect(largest.at(-1)).toMatchObject({ row: 'Z', number: 30 });
  });

  it.each([
    [0, 5],
    [27, 5],
    [5, 0],
    [5, 31],
    [2.5, 5],
  ])('rejects %s×%s', (rows, cols) => {
    expect(() => buildSeatGrid(rows, cols)).toThrow(RangeError);
  });
});

describe('rowLabel / rowIndex', () => {
  it('maps 0–25 to A–Z and back', () => {
    expect(rowLabel(0)).toBe('A');
    expect(rowLabel(25)).toBe('Z');
    expect(rowIndex('A')).toBe(0);
    expect(rowIndex('Z')).toBe(25);
  });

  it('refuses anything outside A–Z', () => {
    expect(() => rowLabel(26)).toThrow(RangeError);
    expect(() => rowLabel(-1)).toThrow(RangeError);
    expect(rowIndex('a')).toBe(-1);
    expect(rowIndex('AA')).toBe(-1);
  });
});
