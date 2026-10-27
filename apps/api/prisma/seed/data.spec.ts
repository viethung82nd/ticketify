import { buildRoomLayout, MOVIES, GENRES, ROOM, SEAT_PRICES } from './data';

describe('seed data', () => {
  const layout = buildRoomLayout(ROOM.rows, ROOM.cols);

  it('builds a full 10×12 grid with unique positions', () => {
    expect(layout).toHaveLength(120);
    expect(new Set(layout.map((s) => `${s.row}-${s.number}`)).size).toBe(120);
    expect(new Set(layout.map((s) => s.row))).toEqual(new Set('ABCDEFGHIJ'.split('')));
  });

  it('contains all three seat types', () => {
    const counts = layout.reduce<Record<string, number>>((acc, s) => {
      acc[s.type] = (acc[s.type] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts).toEqual({ STANDARD: 76, VIP: 32, COUPLE: 12 });
  });

  it('pairs couple seats: exactly two adjacent seats in the same row per group', () => {
    const couples = layout.filter((s) => s.type === 'COUPLE');
    const groups = new Map<number, typeof couples>();
    for (const seat of couples) {
      expect(seat.coupleGroup).not.toBeNull();
      const group = groups.get(seat.coupleGroup!) ?? [];
      group.push(seat);
      groups.set(seat.coupleGroup!, group);
    }

    expect(groups.size).toBe(6);
    for (const [, pair] of groups) {
      expect(pair).toHaveLength(2);
      expect(pair[0]!.row).toBe(pair[1]!.row);
      expect(Math.abs(pair[0]!.number - pair[1]!.number)).toBe(1);
    }
  });

  it('only couple seats have a coupleGroup', () => {
    for (const seat of layout.filter((s) => s.type !== 'COUPLE')) {
      expect(seat.coupleGroup).toBeNull();
    }
  });

  it('prices every seat type × day type', () => {
    for (const type of ['STANDARD', 'VIP', 'COUPLE'] as const) {
      for (const day of ['WEEKDAY', 'WEEKEND', 'HOLIDAY'] as const) {
        expect(Number.isInteger(SEAT_PRICES[type][day])).toBe(true);
        expect(SEAT_PRICES[type][day]).toBeGreaterThan(0);
      }
    }
  });

  it('only references known genres', () => {
    const known = new Set<string>(GENRES.map((g) => g.slug));
    for (const movie of MOVIES) {
      for (const slug of movie.genres) expect(known.has(slug)).toBe(true);
    }
  });
});
