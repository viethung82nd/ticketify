import {
  type CoupleViolation,
  type LayoutChange,
  type LayoutSeat,
  planSeatChanges,
  type SeatPlan,
  SeatType,
} from '@ticketify/shared';

/**
 * A rows×cols room. Seat ids are their labels (`A1`) so expectations read like the grid.
 * `pairs` lists existing couple pairs as [left, right] labels.
 */
function room(rows: string, cols: number, pairs: [string, string][] = []): LayoutSeat[] {
  const seats: LayoutSeat[] = [...rows].flatMap((row) =>
    Array.from({ length: cols }, (_, i) => ({
      id: `${row}${i + 1}`,
      row,
      number: i + 1,
      type: SeatType.STANDARD,
      isActive: true,
      coupleGroup: null,
    })),
  );
  pairs.forEach((pair, index) => {
    for (const id of pair) {
      const seat = seats.find((s) => s.id === id)!;
      seat.type = SeatType.COUPLE;
      seat.coupleGroup = index + 1;
    }
  });
  return seats;
}

const couple = (seatId: string, coupleWith?: string): LayoutChange => ({
  seatId,
  type: SeatType.COUPLE,
  ...(coupleWith === undefined ? {} : { coupleWith }),
});

function applied(plan: SeatPlan): Map<string, LayoutSeat> {
  if (!plan.ok) throw new Error(`Expected success, got ${JSON.stringify(plan)}`);
  return new Map(plan.seats.map((seat) => [seat.id, seat]));
}

function violationsOf(plan: SeatPlan): { code: string; reason: string; seats: string[] }[] {
  if (plan.ok || plan.code === 'SEAT_NOT_FOUND') {
    throw new Error(`Expected couple violations, got ${JSON.stringify(plan)}`);
  }
  return plan.violations.map(({ code, reason, seats }: CoupleViolation) => ({
    code,
    reason,
    seats,
  }));
}

describe('planSeatChanges: creating pairs', () => {
  it('pairs two adjacent seats of the same row (declared from one side)', () => {
    const plan = planSeatChanges(room('AB', 4), [couple('A1', 'A2'), couple('A2')]);

    const seats = applied(plan);
    expect(seats.get('A1')).toMatchObject({ type: 'COUPLE', coupleGroup: 1 });
    expect(seats.get('A2')).toMatchObject({ type: 'COUPLE', coupleGroup: 1 });
    expect(plan.ok && plan.changed.map((seat) => seat.id)).toEqual(['A1', 'A2']);
  });

  it('accepts the same pair declared from both sides', () => {
    const seats = applied(planSeatChanges(room('A', 4), [couple('A3', 'A4'), couple('A4', 'A3')]));

    expect(seats.get('A3')?.coupleGroup).toBe(1);
    expect(seats.get('A4')?.coupleGroup).toBe(1);
  });

  it('gives new pairs group numbers that do not collide with existing pairs', () => {
    const seats = applied(
      planSeatChanges(room('A', 6, [['A1', 'A2']]), [couple('A3', 'A4'), couple('A4')]),
    );

    expect(seats.get('A1')?.coupleGroup).toBe(1);
    expect(seats.get('A3')?.coupleGroup).toBe(2);
    expect(seats.get('A4')?.coupleGroup).toBe(2);
  });

  it('rejects seats in different rows', () => {
    const plan = planSeatChanges(room('AB', 4), [couple('A1', 'B1'), couple('B1')]);

    expect(plan).toMatchObject({ ok: false, code: 'INVALID_COUPLE' });
    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'DIFFERENT_ROWS', seats: ['A1', 'B1'] },
    ]);
  });

  it('rejects seats that are not adjacent', () => {
    const plan = planSeatChanges(room('A', 4), [couple('A1', 'A3'), couple('A3')]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'NOT_ADJACENT', seats: ['A1', 'A3'] },
    ]);
  });

  it('rejects overlapping pairs: one seat in two pairs of the same batch', () => {
    const plan = planSeatChanges(room('A', 4), [
      couple('A1', 'A2'),
      couple('A2'),
      couple('A3', 'A2'),
    ]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'OVERLAPPING_PAIRS', seats: ['A2', 'A1', 'A3'] },
    ]);
  });

  it('rejects a pair missing one side: the partner is not a COUPLE seat', () => {
    const plan = planSeatChanges(room('A', 4), [couple('A1', 'A2')]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'NOT_COUPLE_TYPE', seats: ['A1', 'A2'] },
    ]);
  });

  it('rejects a seat made COUPLE without any partner', () => {
    const plan = planSeatChanges(room('A', 4), [couple('A1')]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'MISSING_PARTNER', seats: ['A1'] },
    ]);
  });

  it('rejects pairing a seat with itself', () => {
    const plan = planSeatChanges(room('A', 2), [couple('A1', 'A1')]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'SELF_PAIR', seats: ['A1'] },
    ]);
  });

  it('rejects a new pair with a seat that is off, unless it is switched on in the batch', () => {
    const seats = room('A', 2);
    seats[1]!.isActive = false;

    expect(violationsOf(planSeatChanges(seats, [couple('A1', 'A2'), couple('A2')]))).toEqual([
      { code: 'INVALID_COUPLE', reason: 'INACTIVE_SEAT', seats: ['A1', 'A2'] },
    ]);
    const fixed = applied(
      planSeatChanges(seats, [couple('A1', 'A2'), { ...couple('A2'), isActive: true }]),
    );
    expect(fixed.get('A2')).toMatchObject({ isActive: true, coupleGroup: 1 });
  });

  it('re-declaring an existing pair changes nothing', () => {
    const plan = planSeatChanges(room('A', 4, [['A1', 'A2']]), [
      { seatId: 'A1', coupleWith: 'A2' },
    ]);

    expect(plan).toMatchObject({ ok: true, changed: [] });
  });

  it('moves pairs when the old partners leave COUPLE in the same batch', () => {
    const before = room('A', 4, [
      ['A1', 'A2'],
      ['A3', 'A4'],
    ]);
    const seats = applied(
      planSeatChanges(before, [
        { seatId: 'A1', type: SeatType.STANDARD },
        { seatId: 'A2', coupleWith: 'A3' },
        { seatId: 'A4', type: SeatType.VIP },
      ]),
    );

    expect(seats.get('A1')).toMatchObject({ type: 'STANDARD', coupleGroup: null });
    expect(seats.get('A4')).toMatchObject({ type: 'VIP', coupleGroup: null });
    expect(seats.get('A2')?.coupleGroup).toBe(seats.get('A3')?.coupleGroup);
    expect(seats.get('A2')?.coupleGroup).not.toBeNull();
  });

  it('rejects taking a seat from another pair without dealing with its old partner', () => {
    const plan = planSeatChanges(room('A', 4, [['A2', 'A3']]), [
      couple('A1', 'A2'),
      // A3 stays COUPLE but loses A2.
    ]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'MISSING_PARTNER', seats: ['A3', 'A2'] },
    ]);
  });
});

describe('planSeatChanges: leaving pairs', () => {
  const paired = () => room('A', 4, [['A1', 'A2']]);

  it('changing both seats away from COUPLE unpairs them automatically', () => {
    const seats = applied(
      planSeatChanges(paired(), [
        { seatId: 'A1', type: SeatType.STANDARD },
        { seatId: 'A2', type: SeatType.VIP },
      ]),
    );

    expect(seats.get('A1')).toMatchObject({ type: 'STANDARD', coupleGroup: null });
    expect(seats.get('A2')).toMatchObject({ type: 'VIP', coupleGroup: null });
  });

  it('changing only one seat away from COUPLE leaves the other without a partner', () => {
    const plan = planSeatChanges(paired(), [{ seatId: 'A1', type: SeatType.STANDARD }]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'MISSING_PARTNER', seats: ['A2', 'A1'] },
    ]);
  });

  it('coupleWith null with a new type on both seats splits the pair', () => {
    const seats = applied(
      planSeatChanges(paired(), [
        { seatId: 'A1', coupleWith: null, type: SeatType.STANDARD },
        { seatId: 'A2', coupleWith: null, type: SeatType.STANDARD },
      ]),
    );

    expect(seats.get('A1')?.coupleGroup).toBeNull();
    expect(seats.get('A2')?.coupleGroup).toBeNull();
  });

  it('coupleWith null alone leaves two COUPLE seats without a pair: one violation', () => {
    const plan = planSeatChanges(paired(), [{ seatId: 'A1', coupleWith: null }]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'MISSING_PARTNER', seats: ['A1', 'A2'] },
    ]);
  });

  it('rejects a batch that both pairs and unpairs the same seat', () => {
    const plan = planSeatChanges(room('A', 4), [
      { seatId: 'A1', coupleWith: null },
      couple('A2', 'A1'),
    ]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'UNPAIR_CONFLICT', seats: ['A2', 'A1'] },
    ]);
  });
});

describe('planSeatChanges: switching seats on and off', () => {
  const paired = () => room('A', 4, [['A1', 'A2']]);

  it('switching one seat of a pair off is COUPLE_INCONSISTENT', () => {
    const plan = planSeatChanges(paired(), [{ seatId: 'A1', isActive: false }]);

    expect(plan).toMatchObject({ ok: false, code: 'COUPLE_INCONSISTENT' });
    expect(violationsOf(plan)).toEqual([
      { code: 'COUPLE_INCONSISTENT', reason: 'ACTIVE_MISMATCH', seats: ['A1', 'A2'] },
    ]);
  });

  it('switching both seats of a pair off (and on again) keeps the pair', () => {
    const off = applied(
      planSeatChanges(paired(), [
        { seatId: 'A1', isActive: false },
        { seatId: 'A2', isActive: false },
      ]),
    );
    expect(off.get('A1')).toMatchObject({ isActive: false, coupleGroup: 1 });
    expect(off.get('A2')).toMatchObject({ isActive: false, coupleGroup: 1 });

    const on = applied(
      planSeatChanges(
        [...off.values()],
        [
          { seatId: 'A1', isActive: true },
          { seatId: 'A2', isActive: true },
        ],
      ),
    );
    expect(on.get('A2')).toMatchObject({ isActive: true, coupleGroup: 1 });
  });

  it('switches ordinary seats freely', () => {
    const seats = applied(planSeatChanges(paired(), [{ seatId: 'A4', isActive: false }]));

    expect(seats.get('A4')?.isActive).toBe(false);
  });
});

describe('planSeatChanges: whole-room checks', () => {
  it('reports unknown seat ids (seat or partner) as SEAT_NOT_FOUND, before anything else', () => {
    const plan = planSeatChanges(room('A', 2), [
      { seatId: 'Z9', type: SeatType.VIP },
      { seatId: 'A1', coupleWith: 'Q1' },
    ]);

    expect(plan).toEqual({ ok: false, code: 'SEAT_NOT_FOUND', seatIds: ['Z9', 'Q1'] });
  });

  it('checks pairs the batch does not touch (a broken stored group)', () => {
    const seats = room('A', 4, [['A1', 'A2']]);
    seats[1]!.coupleGroup = 7; // A1 is now alone in group 1, A2 alone in group 7

    const plan = planSeatChanges(seats, [{ seatId: 'A4', type: SeatType.VIP }]);

    expect(violationsOf(plan)).toEqual([
      { code: 'INVALID_COUPLE', reason: 'BROKEN_GROUP', seats: ['A1'] },
      { code: 'INVALID_COUPLE', reason: 'BROKEN_GROUP', seats: ['A2'] },
    ]);
  });

  it('lists every problem; INVALID_COUPLE wins over COUPLE_INCONSISTENT as the error code', () => {
    const plan = planSeatChanges(room('AB', 4, [['B1', 'B2']]), [
      couple('A1', 'A3'),
      couple('A3'),
      { seatId: 'B1', isActive: false },
    ]);

    expect(plan).toMatchObject({ ok: false, code: 'INVALID_COUPLE' });
    expect(violationsOf(plan).map((v) => v.reason)).toEqual(['NOT_ADJACENT', 'ACTIVE_MISMATCH']);
  });

  it('reports only the seats whose type, state or pair actually changed', () => {
    const plan = planSeatChanges(room('A', 3), [
      { seatId: 'A1', type: SeatType.STANDARD },
      { seatId: 'A2', isActive: true },
      { seatId: 'A3', type: SeatType.VIP },
    ]);

    expect(plan.ok && plan.changed.map((seat) => seat.id)).toEqual(['A3']);
  });
});
