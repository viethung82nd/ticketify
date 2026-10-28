import { ROOM_LIMITS, rowLabel, SeatType } from '@ticketify/shared';

export interface GridSeat {
  row: string;
  number: number;
  type: SeatType;
  isActive: boolean;
  coupleGroup: number | null;
}

/**
 * Every seat of a new rows×cols room: rows labelled A, B, … from the screen back, seats
 * numbered 1…cols from the left. All STANDARD and active; the admin edits types afterwards.
 */
export function buildSeatGrid(rows: number, cols: number): GridSeat[] {
  const inRange = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  if (
    !inRange(rows, ROOM_LIMITS.rowsMin, ROOM_LIMITS.rowsMax) ||
    !inRange(cols, ROOM_LIMITS.colsMin, ROOM_LIMITS.colsMax)
  ) {
    throw new RangeError(`Invalid room size ${rows}×${cols}`);
  }

  const seats: GridSeat[] = [];
  for (let r = 0; r < rows; r++) {
    const row = rowLabel(r);
    for (let number = 1; number <= cols; number++) {
      seats.push({ row, number, type: SeatType.STANDARD, isActive: true, coupleGroup: null });
    }
  }
  return seats;
}
