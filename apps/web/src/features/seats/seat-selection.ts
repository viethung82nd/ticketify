import {
  BOOKING_LIMITS,
  PublicSeatStatus,
  SeatType,
  type ShowtimeSeat,
  type ShowtimeSeatMap,
} from '@ticketify/shared';

/** Pure rules of the customer seat map: selection, couple pairs, realtime updates. */

export const SEAT_TYPE_NAMES: Record<SeatType, string> = {
  [SeatType.STANDARD]: 'Thường',
  [SeatType.VIP]: 'VIP',
  [SeatType.COUPLE]: 'Đôi',
};

export const SEAT_STATUS_NAMES: Record<PublicSeatStatus, string> = {
  [PublicSeatStatus.AVAILABLE]: 'còn trống',
  [PublicSeatStatus.HELD]: 'đang giữ',
  [PublicSeatStatus.SOLD]: 'đã bán',
  [PublicSeatStatus.UNAVAILABLE]: 'không bán',
};

export const SEATS_MAX = BOOKING_LIMITS.seatsMax;

/** A seat that can be picked right now (a seat without price is not sold for this showtime). */
export const isSelectable = (seat: ShowtimeSeat): boolean =>
  seat.status === PublicSeatStatus.AVAILABLE && seat.price !== null;

/** The seats booked together with `seat`: its couple pair (in seat order), or itself. */
export function groupOf(seats: readonly ShowtimeSeat[], seat: ShowtimeSeat): ShowtimeSeat[] {
  if (seat.type !== SeatType.COUPLE || seat.coupleGroup === null) return [seat];
  const pair = seats.filter(
    (other) => other.type === SeatType.COUPLE && other.coupleGroup === seat.coupleGroup,
  );
  return pair.length > 1 ? pair : [seat];
}

/** `B5`, or `B7–B8` for a pair. */
export const groupLabel = (group: readonly ShowtimeSeat[]): string =>
  group.map((seat) => seat.label).join('–');

export interface ToggleResult {
  selected: string[];
  /** Announced in the live region (and shown under the map). */
  message: string;
  /** `true` when nothing changed because the click was refused. */
  refused: boolean;
}

/**
 * Click (or Enter/Space) on `seat`. A couple seat always goes with its partner, both ways; the
 * selection never exceeds `SEATS_MAX` seats.
 */
export function toggleSeat(
  seats: readonly ShowtimeSeat[],
  selected: readonly string[],
  seat: ShowtimeSeat,
): ToggleResult {
  const group = groupOf(seats, seat);
  const label = groupLabel(group);
  const pairWord = group.length > 1 ? 'ghế đôi ' : 'ghế ';

  if (selected.includes(seat.id)) {
    const ids = new Set(group.map((item) => item.id));
    const next = selected.filter((id) => !ids.has(id));
    return {
      selected: next,
      message: `Đã bỏ chọn ${pairWord}${label}. Đang chọn ${next.length}/${SEATS_MAX} ghế.`,
      refused: false,
    };
  }
  const blocked = group.find((item) => !isSelectable(item));
  if (blocked) {
    const why =
      blocked.price === null && blocked.status === PublicSeatStatus.AVAILABLE
        ? 'không bán'
        : SEAT_STATUS_NAMES[blocked.status];
    return {
      selected: [...selected],
      message:
        group.length > 1 && blocked.id !== seat.id
          ? `Không chọn được ghế đôi ${label}: ghế ${blocked.label} ${why}.`
          : `Ghế ${blocked.label} ${why}, không chọn được.`,
      refused: true,
    };
  }
  if (selected.length + group.length > SEATS_MAX) {
    return {
      selected: [...selected],
      message: `Mỗi đơn tối đa ${SEATS_MAX} ghế. Bỏ bớt ghế trước khi chọn ${pairWord}${label}.`,
      refused: true,
    };
  }
  const next = [...selected, ...group.map((item) => item.id)];
  return {
    selected: next,
    message: `Đã chọn ${pairWord}${label}. Đang chọn ${next.length}/${SEATS_MAX} ghế.`,
    refused: false,
  };
}

/**
 * Removes `takenIds` from the selection, with their couple partners (half a pair cannot be
 * booked). Returns the labels of the seats that were selected and are now gone.
 */
export function dropTaken(
  seats: readonly ShowtimeSeat[],
  selected: readonly string[],
  takenIds: readonly string[],
): { selected: string[]; dropped: string[] } {
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  const gone = new Set<string>();
  for (const id of takenIds) {
    if (!selected.includes(id)) continue;
    const seat = byId.get(id);
    for (const item of seat ? groupOf(seats, seat) : []) gone.add(item.id);
    gone.add(id);
  }
  return {
    selected: selected.filter((id) => !gone.has(id)),
    dropped: seats.filter((seat) => gone.has(seat.id)).map((seat) => seat.label),
  };
}

/** "Ghế B5 vừa có người chọn" / "Ghế B5, B6 vừa có người chọn". */
export const takenMessage = (labels: readonly string[]): string =>
  `Ghế ${labels.join(', ')} vừa có người chọn. Ghế đã được bỏ khỏi lựa chọn của bạn.`;

/** "Hàng B, ghế 5, VIP, còn trống, chưa chọn". */
export function seatAriaLabel(
  seats: readonly ShowtimeSeat[],
  seat: ShowtimeSeat,
  isSelected: boolean,
): string {
  const parts = [`Hàng ${seat.row}`, `ghế ${seat.number}`, SEAT_TYPE_NAMES[seat.type]];
  const group = groupOf(seats, seat);
  if (group.length > 1) {
    parts.push(`ghép với ${group.filter((item) => item.id !== seat.id)[0]?.label ?? ''}`);
  }
  const status =
    seat.status === PublicSeatStatus.AVAILABLE && seat.price === null
      ? SEAT_STATUS_NAMES.UNAVAILABLE
      : SEAT_STATUS_NAMES[seat.status];
  parts.push(status, isSelected ? 'đang chọn' : 'chưa chọn');
  return parts.join(', ');
}

// ─── Realtime ───

export type SeatEventStatus =
  typeof PublicSeatStatus.HELD | typeof PublicSeatStatus.AVAILABLE | typeof PublicSeatStatus.SOLD;

/**
 * Statuses an event may find a seat in without implying a missed event. A seat shown AVAILABLE
 * can be released (its hold had already lapsed: the map shows lapsed holds as free). Anything
 * else — an unknown seat, a hold on a seat we think is held or sold, a release of a sold seat —
 * means this copy of the map is out of date.
 */
const EXPECTED_BEFORE: Record<SeatEventStatus, readonly PublicSeatStatus[]> = {
  HELD: [PublicSeatStatus.AVAILABLE],
  AVAILABLE: [PublicSeatStatus.HELD, PublicSeatStatus.AVAILABLE],
  SOLD: [PublicSeatStatus.HELD, PublicSeatStatus.AVAILABLE],
};

/**
 * Applies a seat event to the cached map: only the listed seats change. `mismatch` asks the
 * caller to reload the whole map from the server.
 */
export function applySeatEvent(
  map: ShowtimeSeatMap,
  seatIds: readonly string[],
  status: SeatEventStatus,
): { map: ShowtimeSeatMap; mismatch: boolean } {
  const ids = new Set(seatIds);
  const known = map.seats.filter((seat) => ids.has(seat.id));
  const mismatch =
    known.length !== ids.size ||
    known.some((seat) => seat.price === null || !EXPECTED_BEFORE[status].includes(seat.status));
  return {
    map: {
      ...map,
      seats: map.seats.map((seat) =>
        ids.has(seat.id) && seat.price !== null ? { ...seat, status } : seat,
      ),
    },
    mismatch,
  };
}
