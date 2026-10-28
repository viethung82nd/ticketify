import {
  type AdminSeat,
  type CoupleViolation,
  CoupleViolationReason,
  planSeatChanges,
  type SeatChange,
  seatLabel,
  SeatType,
} from '@ticketify/shared';

/** Editor tools. A type tool or Split applies to both seats of a pair. */
export const SeatTool = {
  STANDARD: 'STANDARD',
  VIP: 'VIP',
  COUPLE: 'COUPLE',
  TOGGLE: 'TOGGLE',
  SPLIT: 'SPLIT',
} as const;
export type SeatTool = (typeof SeatTool)[keyof typeof SeatTool];

export const TOOL_LABELS: Record<SeatTool, string> = {
  STANDARD: 'Ghế thường',
  VIP: 'Ghế VIP',
  COUPLE: 'Ghế đôi',
  TOGGLE: 'Bật/tắt',
  SPLIT: 'Tách cặp',
};

export const TOOL_HINTS: Record<SeatTool, string> = {
  STANDARD: 'Bấm một ghế để đổi thành ghế thường. Ghế trong cặp: đổi cả hai ghế và tách cặp.',
  VIP: 'Bấm một ghế để đổi thành ghế VIP. Ghế trong cặp: đổi cả hai ghế và tách cặp.',
  COUPLE:
    'Bấm hai ghế liền kề trong cùng một hàng để ghép thành ghế đôi. Ghế đang thuộc cặp khác được ghép lại sau khi bạn xác nhận; ghế còn lại của cặp cũ thành ghế thường. Esc để bỏ chọn.',
  TOGGLE: 'Bấm một ghế để tắt hoặc bật. Ghế trong cặp: bật/tắt cả hai ghế.',
  SPLIT: 'Bấm một ghế đôi để tách cặp; cả hai ghế trở thành ghế thường.',
};

export const SEAT_TYPE_LABELS: Record<SeatType, string> = {
  STANDARD: 'Thường',
  VIP: 'VIP',
  COUPLE: 'Đôi',
};

/** One-letter mark shown in each cell, so type is never conveyed by colour alone. */
export const SEAT_TYPE_MARKS: Record<SeatType, string> = {
  STANDARD: 'T',
  VIP: 'V',
  COUPLE: 'Đ',
};

export const partnerOf = (seats: readonly AdminSeat[], seat: AdminSeat): AdminSeat | undefined =>
  seat.coupleGroup === null
    ? undefined
    : seats.find((other) => other.coupleGroup === seat.coupleGroup && other.id !== seat.id);

export interface ToolResult {
  seats: AdminSeat[];
  /** First seat picked by the couple tool, waiting for its partner. */
  pending: string | null;
  /** Shown next to the toolbar (role=status); after confirming when `confirm` is set. */
  message: string | null;
  /**
   * Set when the action also splits existing pairs: the question to ask first. `seats` is
   * then the draft to apply only once the admin confirms.
   */
  confirm: string | null;
}

const update = (
  seats: readonly AdminSeat[],
  ids: readonly string[],
  patch: Partial<AdminSeat>,
): AdminSeat[] => seats.map((seat) => (ids.includes(seat.id) ? { ...seat, ...patch } : seat));

const pairName = (a: AdminSeat, b: AdminSeat) => `${seatLabel(a)}–${seatLabel(b)}`;

/** Left seat first, then upper row first: how an existing pair is named. */
const inOrder = (a: AdminSeat, b: AdminSeat): [AdminSeat, AdminSeat] =>
  a.row === b.row ? (a.number < b.number ? [a, b] : [b, a]) : a.row < b.row ? [a, b] : [b, a];

/**
 * Applies `tool` to the seat `seatId` of the draft. Pure: returns the new draft.
 * The couple tool creates whatever pair is asked, taking seats out of their current pairs
 * (the partner left behind becomes STANDARD, so the result is one valid batch). The editor
 * refuses a result for which `planSeatChanges` reports a new problem (`addedViolations`):
 * different rows, not adjacent, seat off, exactly as the server would.
 */
export function applyTool(
  seats: readonly AdminSeat[],
  seatId: string,
  tool: SeatTool,
  pending: string | null,
): ToolResult {
  const seat = seats.find((s) => s.id === seatId);
  if (!seat) return { seats: [...seats], pending, message: null, confirm: null };
  const partner = partnerOf(seats, seat);
  const both = partner ? [seat.id, partner.id] : [seat.id];
  const done = (next: AdminSeat[], message: string | null = null): ToolResult => ({
    seats: next,
    pending: null,
    message,
    confirm: null,
  });

  switch (tool) {
    case SeatTool.STANDARD:
    case SeatTool.VIP:
      return done(update(seats, both, { type: tool, coupleGroup: null }));

    case SeatTool.TOGGLE:
      return done(update(seats, both, { isActive: !seat.isActive }));

    case SeatTool.SPLIT:
      if (!partner) return done([...seats], `Ghế ${seatLabel(seat)} không thuộc cặp ghế đôi nào.`);
      return done(update(seats, both, { type: SeatType.STANDARD, coupleGroup: null }));

    case SeatTool.COUPLE: {
      if (pending === null) {
        return {
          seats: [...seats],
          pending: seat.id,
          message: partner
            ? `Đã chọn ${seatLabel(seat)} (đang ghép với ${seatLabel(partner)}). Bấm ghế liền kề để ghép lại.`
            : `Đã chọn ${seatLabel(seat)}. Bấm ghế liền kề để ghép cặp.`,
          confirm: null,
        };
      }
      if (pending === seat.id) return done([...seats], 'Đã bỏ chọn.');
      const first = seats.find((s) => s.id === pending);
      if (!first) return done([...seats]);
      const ordered = inOrder(first, seat);
      const paired = pairName(...ordered);
      if (partner?.id === first.id) return done([...seats], `${paired} đã là một cặp ghế đôi.`);

      // Both seats leave their current pairs; each partner left behind becomes STANDARD.
      const splits = ordered.flatMap((member) => {
        const old = partnerOf(seats, member);
        return old ? [{ pair: inOrder(member, old), left: old }] : [];
      });
      const group = Math.max(0, ...seats.map((s) => s.coupleGroup ?? 0)) + 1;
      const next = update(
        update(
          seats,
          splits.map(({ left }) => left.id),
          { type: SeatType.STANDARD, coupleGroup: null },
        ),
        [first.id, seat.id],
        { type: SeatType.COUPLE, coupleGroup: group },
      );
      if (splits.length === 0) return done(next, `Đã ghép ${paired}.`);

      const standard = SEAT_TYPE_LABELS[SeatType.STANDARD];
      const steps = splits.map(
        ({ pair, left }) => `tách ${pairName(...pair)} (${seatLabel(left)} thành ${standard})`,
      );
      const leftLabels = splits.map(({ left }) => seatLabel(left)).join(', ');
      return {
        seats: next,
        pending: null,
        message: `Đã ghép ${paired}; ${leftLabels} thành ghế thường.`,
        confirm: `Sẽ ${steps.join(', ')} và ghép ${paired}.`,
      };
    }
  }
}

/**
 * The PATCH payload that turns `base` into `draft`: type/isActive where they differ, and
 * `coupleWith` on both seats of every new pair (`null` for seats that left a pair).
 */
export function diffSeats(base: readonly AdminSeat[], draft: readonly AdminSeat[]): SeatChange[] {
  const before = new Map(base.map((seat) => [seat.id, seat]));
  const changes: SeatChange[] = [];
  for (const seat of draft) {
    const old = before.get(seat.id);
    if (!old) continue;
    const change: SeatChange = { seatId: seat.id };
    if (seat.type !== old.type) change.type = seat.type;
    if (seat.isActive !== old.isActive) change.isActive = seat.isActive;
    const oldPartner = partnerOf(base, old)?.id ?? null;
    const newPartner = partnerOf(draft, seat)?.id ?? null;
    if (newPartner !== oldPartner) change.coupleWith = newPartner;
    if (Object.keys(change).length > 1) changes.push(change);
  }
  return changes;
}

/** Couple problems of `draft` as a batch against the loaded layout `base` (none if unchanged). */
export function draftViolations(
  base: readonly AdminSeat[],
  draft: readonly AdminSeat[],
): CoupleViolation[] {
  const changes = diffSeats(base, draft);
  if (changes.length === 0) return [];
  const plan = planSeatChanges(base, changes);
  return !plan.ok && 'violations' in plan ? plan.violations : [];
}

/** Problems `next` has that `draft` did not: an edit that adds any is not applied. */
export function addedViolations(
  base: readonly AdminSeat[],
  draft: readonly AdminSeat[],
  next: readonly AdminSeat[],
): CoupleViolation[] {
  const key = (violation: CoupleViolation) =>
    `${violation.reason}:${[...violation.seatIds].sort().join(',')}`;
  const known = new Set(draftViolations(base, draft).map(key));
  return draftViolations(base, next).filter((violation) => !known.has(key(violation)));
}

/** Vietnamese explanation of one couple violation (from the client check or the server). */
export function violationMessage(violation: Pick<CoupleViolation, 'reason' | 'seats'>): string {
  const [a = '?', b = '?', c] = violation.seats;
  switch (violation.reason) {
    case CoupleViolationReason.SELF_PAIR:
      return `Ghế ${a} không thể ghép đôi với chính nó.`;
    case CoupleViolationReason.OVERLAPPING_PAIRS:
      return `Ghế ${a} nằm trong nhiều cặp cùng lúc (${[b, c].filter(Boolean).join(', ')}).`;
    case CoupleViolationReason.UNPAIR_CONFLICT:
      return `Cặp ${a}–${b} vừa được ghép vừa được tách trong cùng một lần lưu.`;
    case CoupleViolationReason.NOT_COUPLE_TYPE:
      return `Cặp ${a}–${b}: cả hai ghế phải là ghế đôi.`;
    case CoupleViolationReason.DIFFERENT_ROWS:
      return `Cặp ${a}–${b}: hai ghế phải cùng một hàng.`;
    case CoupleViolationReason.NOT_ADJACENT:
      return `Cặp ${a}–${b}: hai ghế phải liền kề nhau.`;
    case CoupleViolationReason.INACTIVE_SEAT:
      return `Cặp ${a}–${b}: không thể ghép cặp với ghế đang tắt. Bật ghế trước.`;
    case CoupleViolationReason.MISSING_PARTNER:
      return violation.seats.length > 1
        ? `Ghế ${a} là ghế đôi nhưng thiếu ghế còn lại (trước đây ghép với ${b}).`
        : `Ghế ${a} là ghế đôi nhưng thiếu ghế còn lại.`;
    case CoupleViolationReason.BROKEN_GROUP:
      return `Nhóm ghế đôi ${violation.seats.join(', ')} không gồm đúng hai ghế.`;
    case CoupleViolationReason.ACTIVE_MISMATCH:
      return `Cặp ${a}–${b}: phải bật hoặc tắt cả hai ghế cùng lúc.`;
  }
}
