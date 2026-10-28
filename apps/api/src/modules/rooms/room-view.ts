import type { AdminRoom, AdminRoomSummary, AdminSeat, RoomLock } from '@ticketify/shared';
import type { Prisma, Room } from '../../generated/prisma/client';

export const SEAT_SELECT = {
  id: true,
  row: true,
  number: true,
  type: true,
  isActive: true,
  coupleGroup: true,
} satisfies Prisma.SeatSelect;

/** Front row first, then left to right. Row labels are single letters, so text order works. */
export const SEAT_ORDER = [
  { row: 'asc' },
  { number: 'asc' },
] satisfies Prisma.SeatOrderByWithRelationInput[];

/** Row of the `GET /admin/rooms` aggregate query. */
export interface RoomSummaryRow {
  id: string;
  name: string;
  rows: number;
  cols: number;
  created_at: Date;
  updated_at: Date;
  seat_count: number;
  active_seat_count: number;
}

export const toRoomSummary = (row: RoomSummaryRow): AdminRoomSummary => ({
  id: row.id,
  name: row.name,
  rows: row.rows,
  cols: row.cols,
  seatCount: row.seat_count,
  activeSeatCount: row.active_seat_count,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const toAdminRoom = (room: Room, seats: AdminSeat[], lock: RoomLock | null): AdminRoom => ({
  id: room.id,
  name: room.name,
  rows: room.rows,
  cols: room.cols,
  lock,
  seats,
  createdAt: room.createdAt.toISOString(),
  updatedAt: room.updatedAt.toISOString(),
});
