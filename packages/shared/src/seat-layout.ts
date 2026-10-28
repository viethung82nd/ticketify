/**
 * Couple-seat rules for a room's seat layout, as one pure function used by the API (the
 * authority: it re-runs this on the locked rows) and by the web editor (early feedback).
 *
 * Rules every room must satisfy after any batch of changes:
 * 1. A COUPLE seat always belongs to exactly one pair; a non-COUPLE seat to none.
 * 2. A pair is two COUPLE seats in the same row with adjacent numbers.
 * 3. Both seats of a pair are on, or both are off. A new pair must start with both seats on.
 */
import { SeatType } from './enums.js';
import { seatLabel } from './schemas/room.js';

export interface LayoutSeat {
  id: string;
  row: string;
  number: number;
  type: SeatType;
  isActive: boolean;
  /** Pair id within the room; the two seats of a pair share it. */
  coupleGroup: number | null;
}

/** Same shape as `seatChangeSchema` (kept structural so callers need no zod). */
export interface LayoutChange {
  seatId: string;
  type?: SeatType;
  isActive?: boolean;
  /** Seat to pair with, or `null` to leave the current pair. */
  coupleWith?: string | null;
}

/** Why a batch breaks the couple rules. */
export const CoupleViolationReason = {
  /** `coupleWith` names the seat itself. */
  SELF_PAIR: 'SELF_PAIR',
  /** The batch puts one seat into two pairs. */
  OVERLAPPING_PAIRS: 'OVERLAPPING_PAIRS',
  /** The batch both pairs a seat and removes it from its pair (`coupleWith: null`). */
  UNPAIR_CONFLICT: 'UNPAIR_CONFLICT',
  /** A pair where a seat is not of type COUPLE. */
  NOT_COUPLE_TYPE: 'NOT_COUPLE_TYPE',
  DIFFERENT_ROWS: 'DIFFERENT_ROWS',
  NOT_ADJACENT: 'NOT_ADJACENT',
  /** A new pair with a seat that is off. */
  INACTIVE_SEAT: 'INACTIVE_SEAT',
  /** A COUPLE seat left without a partner (e.g. only one side of a pair was changed). */
  MISSING_PARTNER: 'MISSING_PARTNER',
  /** Stored data where a couple group does not have exactly two seats. */
  BROKEN_GROUP: 'BROKEN_GROUP',
  /** One seat of a pair on, the other off (`COUPLE_INCONSISTENT`). */
  ACTIVE_MISMATCH: 'ACTIVE_MISMATCH',
} as const;
export type CoupleViolationReason =
  (typeof CoupleViolationReason)[keyof typeof CoupleViolationReason];

export type CoupleViolationCode = 'INVALID_COUPLE' | 'COUPLE_INCONSISTENT';

export interface CoupleViolation {
  code: CoupleViolationCode;
  reason: CoupleViolationReason;
  /** Seats involved, the offending one first. */
  seatIds: string[];
  /** Their labels (`A5`), in the same order. */
  seats: string[];
}

export type SeatPlan =
  | {
      ok: true;
      /** Every seat of the room after the batch, in input order. */
      seats: LayoutSeat[];
      /** Only seats whose type, isActive or coupleGroup changed. */
      changed: LayoutSeat[];
    }
  /** A seat listed more than once: the batch is ambiguous, so it is refused as a whole. */
  | { ok: false; code: 'INVALID_CHANGES'; seatIds: string[] }
  | { ok: false; code: 'SEAT_NOT_FOUND'; seatIds: string[] }
  | { ok: false; code: CoupleViolationCode; violations: CoupleViolation[] };

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const byPosition = (a: LayoutSeat, b: LayoutSeat): number =>
  a.row === b.row ? a.number - b.number : a.row < b.row ? -1 : 1;

/** Seats of each couple group, keyed by group number. */
function groupsOf(seats: Iterable<LayoutSeat>): Map<number, LayoutSeat[]> {
  const groups = new Map<number, LayoutSeat[]>();
  for (const seat of seats) {
    if (seat.coupleGroup === null) continue;
    const members = groups.get(seat.coupleGroup);
    if (members) members.push(seat);
    else groups.set(seat.coupleGroup, [seat]);
  }
  return groups;
}

/**
 * Applies `changes` to `seats` (all seats of one room) and checks the couple rules on the
 * whole resulting room. All-or-nothing: either the full new layout or every problem found.
 *
 * Each seat may appear at most once in `changes` (INVALID_CHANGES otherwise).
 *
 * Pair handling:
 * - `coupleWith: X` pairs the seat with X (declaring it from one side is enough). Both seats
 *   leave their previous pairs; a former partner that is not re-paired or changed to another
 *   type is reported as MISSING_PARTNER. So re-pairing a seat in one batch means: the new pair,
 *   plus each former partner changed to another type.
 * - `coupleWith: null`, or a type other than COUPLE, removes the seat's pair from both seats.
 * - Group numbers are derived: new pairs get the next free number in the room.
 */
export function planSeatChanges(
  seats: readonly LayoutSeat[],
  changes: readonly LayoutChange[],
): SeatPlan {
  const original = new Map(seats.map((seat) => [seat.id, seat]));

  const listed = new Set<string>();
  const repeated = new Set<string>();
  for (const change of changes) {
    if (listed.has(change.seatId)) repeated.add(change.seatId);
    listed.add(change.seatId);
  }
  if (repeated.size > 0) return { ok: false, code: 'INVALID_CHANGES', seatIds: [...repeated] };

  const unknown = new Set<string>();
  for (const change of changes) {
    if (!original.has(change.seatId)) unknown.add(change.seatId);
    if (typeof change.coupleWith === 'string' && !original.has(change.coupleWith)) {
      unknown.add(change.coupleWith);
    }
  }
  if (unknown.size > 0) return { ok: false, code: 'SEAT_NOT_FOUND', seatIds: [...unknown] };

  const violations: CoupleViolation[] = [];
  const report = (code: CoupleViolationCode, reason: CoupleViolationReason, ids: string[]) => {
    violations.push({
      code,
      reason,
      seatIds: ids,
      seats: ids.map((id) => seatLabel(original.get(id)!)),
    });
  };
  const failed = (): SeatPlan => ({
    ok: false,
    code: violations.some((v) => v.code === 'INVALID_COUPLE')
      ? 'INVALID_COUPLE'
      : 'COUPLE_INCONSISTENT',
    violations,
  });

  // ─── 1. Pairs declared by the batch ───
  const leaving = new Set<string>();
  const declared: [string, string][] = [];
  const declaredKeys = new Set<string>();
  for (const change of changes) {
    if (change.coupleWith === null) {
      leaving.add(change.seatId);
    } else if (typeof change.coupleWith === 'string') {
      if (change.coupleWith === change.seatId) {
        report('INVALID_COUPLE', CoupleViolationReason.SELF_PAIR, [change.seatId]);
        continue;
      }
      // A→B and B→A declare the same pair.
      const key = pairKey(change.seatId, change.coupleWith);
      if (declaredKeys.has(key)) continue;
      declaredKeys.add(key);
      declared.push([change.seatId, change.coupleWith]);
    }
  }

  const partnersInBatch = new Map<string, string[]>();
  for (const [a, b] of declared) {
    partnersInBatch.set(a, [...(partnersInBatch.get(a) ?? []), b]);
    partnersInBatch.set(b, [...(partnersInBatch.get(b) ?? []), a]);
  }
  for (const [seatId, partners] of partnersInBatch) {
    if (partners.length > 1) {
      report('INVALID_COUPLE', CoupleViolationReason.OVERLAPPING_PAIRS, [seatId, ...partners]);
    }
  }
  for (const [a, b] of declared) {
    if (leaving.has(a) || leaving.has(b)) {
      report('INVALID_COUPLE', CoupleViolationReason.UNPAIR_CONFLICT, [a, b]);
    }
  }
  // A malformed batch: report it alone instead of the knock-on effects on the layout.
  if (violations.length > 0) return failed();

  // ─── 2. Type and on/off ───
  const next = new Map(seats.map((seat) => [seat.id, { ...seat }]));
  const seat = (id: string): LayoutSeat => next.get(id)!;
  for (const change of changes) {
    const target = seat(change.seatId);
    if (change.type !== undefined) target.type = change.type;
    if (change.isActive !== undefined) target.isActive = change.isActive;
  }

  // ─── 3. Leave old pairs ───
  const originalGroups = groupsOf(seats);
  const partnerOf = (id: string): string | undefined => {
    const group = original.get(id)!.coupleGroup;
    const members = group === null ? undefined : originalGroups.get(group);
    return members?.length === 2 ? members.find((member) => member.id !== id)?.id : undefined;
  };

  const unchangedPairs = new Set<string>();
  const leavers = new Set<string>(leaving);
  const isCouple = (id: string): boolean => seat(id).type === SeatType.COUPLE;
  for (const [a, b] of declared) {
    // Re-declaring an existing pair keeps it (and its group number) as it is.
    if (partnerOf(a) === b && isCouple(a) && isCouple(b)) unchangedPairs.add(pairKey(a, b));
    else leavers.add(a).add(b);
  }
  for (const target of next.values()) {
    if (!isCouple(target.id)) leavers.add(target.id);
  }

  const formerPartner = new Map<string, string>();
  for (const id of leavers) {
    const group = original.get(id)!.coupleGroup;
    if (group === null) continue;
    for (const member of originalGroups.get(group) ?? []) {
      seat(member.id).coupleGroup = null;
      const other = partnerOf(member.id);
      if (other !== undefined) formerPartner.set(member.id, other);
    }
  }

  // ─── 4. Form new pairs ───
  let nextGroup = 1;
  for (const target of next.values()) {
    if (target.coupleGroup !== null) nextGroup = Math.max(nextGroup, target.coupleGroup + 1);
  }
  const newGroups = new Set<number>();
  for (const [a, b] of declared) {
    if (unchangedPairs.has(pairKey(a, b))) continue;
    seat(a).coupleGroup = nextGroup;
    seat(b).coupleGroup = nextGroup;
    newGroups.add(nextGroup);
    nextGroup += 1;
  }

  // ─── 5. Check the whole room ───
  for (const [group, members] of groupsOf(next.values())) {
    const ids = members.map((member) => member.id);
    if (members.length !== 2) {
      report('INVALID_COUPLE', CoupleViolationReason.BROKEN_GROUP, ids);
      continue;
    }
    const [first, second] = [...members].sort(byPosition) as [LayoutSeat, LayoutSeat];
    const pair = [first.id, second.id];
    if (first.type !== SeatType.COUPLE || second.type !== SeatType.COUPLE) {
      report('INVALID_COUPLE', CoupleViolationReason.NOT_COUPLE_TYPE, pair);
    } else if (first.row !== second.row) {
      report('INVALID_COUPLE', CoupleViolationReason.DIFFERENT_ROWS, pair);
    } else if (second.number - first.number !== 1) {
      report('INVALID_COUPLE', CoupleViolationReason.NOT_ADJACENT, pair);
    } else if (newGroups.has(group) && !(first.isActive && second.isActive)) {
      report('INVALID_COUPLE', CoupleViolationReason.INACTIVE_SEAT, pair);
    } else if (first.isActive !== second.isActive) {
      report('COUPLE_INCONSISTENT', CoupleViolationReason.ACTIVE_MISMATCH, pair);
    }
  }

  const reported = new Set<string>();
  for (const target of next.values()) {
    if (target.type !== SeatType.COUPLE || target.coupleGroup !== null) continue;
    if (reported.has(target.id)) continue;
    const former = formerPartner.get(target.id);
    // A broken pair whose two seats are both left alone is one problem, not two.
    const ids = former === undefined ? [target.id] : [target.id, former];
    for (const id of ids) reported.add(id);
    report('INVALID_COUPLE', CoupleViolationReason.MISSING_PARTNER, ids);
  }

  if (violations.length > 0) return failed();

  const result = [...next.values()];
  const changed = result.filter((after) => {
    const before = original.get(after.id)!;
    return (
      before.type !== after.type ||
      before.isActive !== after.isActive ||
      before.coupleGroup !== after.coupleGroup
    );
  });
  return { ok: true, seats: result, changed };
}
