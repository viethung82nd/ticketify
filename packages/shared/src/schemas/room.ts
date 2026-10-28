import { z } from 'zod';
import { SeatType } from '../enums.js';

/** Limits shared by the API DTOs and the web forms so both validate the same way. */
export const ROOM_LIMITS = {
  nameMax: 50,
  rowsMin: 1,
  /** Rows are labelled with one letter, A–Z. */
  rowsMax: 26,
  colsMin: 1,
  colsMax: 30,
  /** Seat changes accepted by one `PATCH /admin/rooms/:id/seats`. */
  seatChangesMax: 500,
} as const;

const FIRST_ROW_CODE = 'A'.charCodeAt(0);

/** Label of a 0-based row index: 0 → `A`, 25 → `Z`. */
export function rowLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= ROOM_LIMITS.rowsMax) {
    throw new RangeError(`Row index must be 0–${ROOM_LIMITS.rowsMax - 1}, got ${index}`);
  }
  return String.fromCharCode(FIRST_ROW_CODE + index);
}

/** 0-based index of a row label (`A` → 0), or -1 for anything else. */
export function rowIndex(label: string): number {
  if (!/^[A-Z]$/.test(label)) return -1;
  return label.charCodeAt(0) - FIRST_ROW_CODE;
}

/** Short seat name shown to people: `A5`. */
export const seatLabel = (seat: { row: string; number: number }): string =>
  `${seat.row}${seat.number}`;

const hasUniqueSeatIds = (changes: readonly { seatId: string }[]): boolean =>
  new Set(changes.map((change) => change.seatId)).size === changes.length;

// ─── Requests ───

const roomNameSchema = z
  .string({ error: 'Vui lòng nhập tên phòng' })
  .trim()
  .min(1, { error: 'Vui lòng nhập tên phòng' })
  .max(ROOM_LIMITS.nameMax, { error: `Tên phòng tối đa ${ROOM_LIMITS.nameMax} ký tự` });

const gridSizeSchema = (label: string, min: number, max: number) =>
  z
    .number({ error: `Vui lòng nhập số ${label}` })
    .int({ error: `Số ${label} phải là số nguyên` })
    .min(min, { error: `Số ${label} từ ${min} đến ${max}` })
    .max(max, { error: `Số ${label} từ ${min} đến ${max}` });

/** `POST /admin/rooms`: the room and its full seat grid (every seat STANDARD and active). */
export const createRoomRequestSchema = z.object({
  name: roomNameSchema,
  rows: gridSizeSchema('hàng', ROOM_LIMITS.rowsMin, ROOM_LIMITS.rowsMax),
  cols: gridSizeSchema('cột', ROOM_LIMITS.colsMin, ROOM_LIMITS.colsMax),
});
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

/** `PATCH /admin/rooms/:id`. Allowed even while the room has upcoming showtimes. */
export const renameRoomRequestSchema = z.object({ name: roomNameSchema });
export type RenameRoomRequest = z.infer<typeof renameRoomRequestSchema>;

/**
 * One element of `PATCH /admin/rooms/:id/seats`. Omitted fields are left unchanged.
 * `coupleWith`: id of the seat to pair with (both must end up COUPLE), or `null` to leave the
 * current pair. Changing a seat's type away from COUPLE also leaves its pair.
 */
export const seatChangeSchema = z.object({
  seatId: z.uuid(),
  type: z.enum(SeatType).optional(),
  isActive: z.boolean().optional(),
  coupleWith: z.uuid().nullable().optional(),
});
export type SeatChange = z.infer<typeof seatChangeSchema>;

export const updateSeatsRequestSchema = z.object({
  changes: z
    .array(seatChangeSchema)
    .min(1, { error: 'Chưa có thay đổi nào' })
    .max(ROOM_LIMITS.seatChangesMax, {
      error: `Tối đa ${ROOM_LIMITS.seatChangesMax} ghế mỗi lần lưu`,
    })
    .refine(hasUniqueSeatIds, { error: 'Mỗi ghế chỉ xuất hiện một lần' }),
});
export type UpdateSeatsRequest = z.infer<typeof updateSeatsRequestSchema>;

// ─── Responses ───

export const adminSeatSchema = z.object({
  id: z.uuid(),
  /** `A`–`Z`. */
  row: z.string(),
  /** 1-based, left to right. */
  number: z.number().int(),
  type: z.enum(SeatType),
  isActive: z.boolean(),
  /** The two seats of a couple pair share a group number (unique within the room). */
  coupleGroup: z.number().int().nullable(),
});
export type AdminSeat = z.infer<typeof adminSeatSchema>;

/**
 * Present while the room has SCHEDULED showtimes that have not ended: the seat layout is
 * frozen (prices and seat states are locked per showtime), only the name may change.
 */
export const roomLockSchema = z.object({
  activeShowtimeCount: z.number().int(),
  /** ISO instant at which the last of those showtimes ends. */
  until: z.string(),
});
export type RoomLock = z.infer<typeof roomLockSchema>;

/** `GET /admin/rooms`. */
export const adminRoomSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  rows: z.number().int(),
  cols: z.number().int(),
  seatCount: z.number().int(),
  activeSeatCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminRoomSummary = z.infer<typeof adminRoomSummarySchema>;

/** `GET /admin/rooms/:id`: seats ordered by row, then number. */
export const adminRoomSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  rows: z.number().int(),
  cols: z.number().int(),
  lock: roomLockSchema.nullable(),
  seats: z.array(adminSeatSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminRoom = z.infer<typeof adminRoomSchema>;

/** Machine-readable `code` values of room and seat-layout API errors. */
export const RoomErrorCode = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_NAME_TAKEN: 'ROOM_NAME_TAKEN',
  /** 409: delete refused, the room has (or had) showtimes. */
  ROOM_HAS_SHOWTIMES: 'ROOM_HAS_SHOWTIMES',
  /** 409: seat layout frozen by upcoming showtimes; `details` is a `RoomLock`. */
  ROOM_IN_USE: 'ROOM_IN_USE',
  /** 422: `details.seatIds` lists ids that are not seats of this room. */
  SEAT_NOT_FOUND: 'SEAT_NOT_FOUND',
  /** 422: couple pair rules broken; `details.violations` lists them. */
  INVALID_COUPLE: 'INVALID_COUPLE',
  /** 422: a pair would end up with one seat on and one off; `details.violations`. */
  COUPLE_INCONSISTENT: 'COUPLE_INCONSISTENT',
} as const;
export type RoomErrorCode = (typeof RoomErrorCode)[keyof typeof RoomErrorCode];
