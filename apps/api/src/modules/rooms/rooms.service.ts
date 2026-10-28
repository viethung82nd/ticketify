import { type HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  type AdminRoom,
  type AdminRoomSummary,
  planSeatChanges,
  RoomErrorCode,
  type RoomLock,
  type SeatPlan,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { isPrismaError, PrismaErrorCode } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { CreateRoomDto, RenameRoomDto, UpdateSeatsDto } from './dto/room.dto';
import {
  SEAT_ORDER,
  SEAT_SELECT,
  toAdminRoom,
  toRoomSummary,
  type RoomSummaryRow,
} from './room-view';
import { buildSeatGrid } from './seat-grid';

type Db = Prisma.TransactionClient | PrismaService;

/** "Phòng 2" before "Phòng 10", and Vietnamese letter order (Đ after D). */
const byName = new Intl.Collator('vi', { sensitivity: 'base', numeric: true });

const roomNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, RoomErrorCode.ROOM_NOT_FOUND, 'Room not found');

const nameTaken = () =>
  apiException(HttpStatus.CONFLICT, RoomErrorCode.ROOM_NAME_TAKEN, 'Room name already in use', {
    field: 'name',
  });

const hasShowtimes = (showtimeCount?: number) =>
  apiException(
    HttpStatus.CONFLICT,
    RoomErrorCode.ROOM_HAS_SHOWTIMES,
    'Room has showtimes and cannot be deleted',
    showtimeCount === undefined ? undefined : { showtimeCount },
  );

const roomInUse = (lock: RoomLock) =>
  apiException(
    HttpStatus.CONFLICT,
    RoomErrorCode.ROOM_IN_USE,
    'The seat layout is locked until the room has no upcoming showtimes; renaming is still allowed',
    lock,
  );

function seatPlanError(plan: Exclude<SeatPlan, { ok: true }>): HttpException {
  if (plan.code === 'INVALID_CHANGES') {
    return apiException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      RoomErrorCode.INVALID_CHANGES,
      'Each seat may appear only once in a batch',
      { seatIds: plan.seatIds },
    );
  }
  if (plan.code === 'SEAT_NOT_FOUND') {
    return apiException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      RoomErrorCode.SEAT_NOT_FOUND,
      'Some seats do not belong to this room',
      { seatIds: plan.seatIds },
    );
  }
  return apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    plan.code,
    plan.code === RoomErrorCode.INVALID_COUPLE
      ? 'Couple seats must be two adjacent COUPLE seats in the same row, each in exactly one pair'
      : 'Both seats of a couple pair must be switched on or off together',
    { violations: plan.violations },
  );
}

/**
 * Rooms and their seat grids (ROADMAP 1.9).
 *
 * Seat-layout lock: while a room has a SCHEDULED showtime that has not ended, its seats'
 * type / on-off / pairs cannot change (`409 ROOM_IN_USE`). Each showtime copies the layout into
 * its ShowtimeSeat rows with the price locked at creation, so editing the room mid-run would
 * make the room and its showtimes disagree. Renaming is always allowed.
 */
@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async list(): Promise<AdminRoomSummary[]> {
    const rows = await this.prisma.$queryRaw<RoomSummaryRow[]>`
      SELECT r.id, r.name, r.rows, r.cols, r.created_at, r.updated_at,
             count(s.id)::int AS seat_count,
             (count(s.id) FILTER (WHERE s.is_active))::int AS active_seat_count
      FROM rooms r
      LEFT JOIN seats s ON s.room_id = r.id
      GROUP BY r.id`;
    return rows.map(toRoomSummary).sort((a, b) => byName.compare(a.name, b.name));
  }

  async get(id: string): Promise<AdminRoom> {
    const room = await this.prisma.room.findUnique({
      where: { id },
      include: { seats: { select: SEAT_SELECT, orderBy: SEAT_ORDER } },
    });
    if (!room) throw roomNotFound();
    return toAdminRoom(room, room.seats, await this.lockOf(this.prisma, id));
  }

  async create(dto: CreateRoomDto): Promise<AdminRoom> {
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const room = await tx.room.create({
          data: { name: dto.name, rows: dto.rows, cols: dto.cols },
        });
        await tx.seat.createMany({
          data: buildSeatGrid(dto.rows, dto.cols).map((seat) => ({ roomId: room.id, ...seat })),
        });
        return room.id;
      });
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) throw nameTaken();
      throw error;
    }
    return this.get(id);
  }

  async rename(id: string, dto: RenameRoomDto): Promise<AdminRoom> {
    try {
      await this.prisma.room.update({ where: { id }, data: { name: dto.name } });
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) throw nameTaken();
      if (isPrismaError(error, PrismaErrorCode.recordNotFound)) throw roomNotFound();
      throw error;
    }
    return this.get(id);
  }

  /** Only a room that never had a showtime (any status): showtimes keep pointing at it. */
  async remove(id: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // Inserting a showtime takes a key-share lock on the room (FK check), which conflicts
        // with FOR UPDATE: a concurrent insert is either counted below or waits and then fails.
        await this.lockRoom(tx, id);
        const showtimeCount = await tx.showtime.count({ where: { roomId: id } });
        if (showtimeCount > 0) throw hasShowtimes(showtimeCount);
        await tx.room.delete({ where: { id } }); // seats cascade
      });
    } catch (error) {
      // showtimes.room_id is ON DELETE RESTRICT: the database is the last line of defence.
      if (isPrismaError(error, PrismaErrorCode.foreignKeyViolation)) throw hasShowtimes();
      throw error;
    }
  }

  /**
   * Applies a batch of seat changes all-or-nothing and returns the room's new grid.
   *
   * The room row is locked FOR UPDATE first, so concurrent batches on one room run one after
   * the other and each validates against the layout the previous one committed (never a stale
   * read). The rules are checked on the whole room (`planSeatChanges`), not just on the seats
   * in the batch.
   */
  async updateSeats(id: string, dto: UpdateSeatsDto): Promise<AdminRoom> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockRoom(tx, id);
      const lock = await this.lockOf(tx, id);
      if (lock) throw roomInUse(lock);

      const seats = await tx.seat.findMany({
        where: { roomId: id },
        select: SEAT_SELECT,
        orderBy: SEAT_ORDER,
      });
      const plan = planSeatChanges(seats, dto.changes);
      if (!plan.ok) throw seatPlanError(plan);
      await this.writeSeats(tx, id, plan.changed);
    });
    return this.get(id);
  }

  // ─── Helpers ───

  private async lockRoom(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM rooms WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw roomNotFound();
  }

  /** Upcoming or running showtimes that freeze the layout, or `null` when there are none. */
  private async lockOf(db: Db, roomId: string): Promise<RoomLock | null> {
    const active = await db.showtime.aggregate({
      where: { roomId, status: 'SCHEDULED', endsAt: { gt: this.clock.now() } },
      _count: { _all: true },
      _max: { endsAt: true },
    });
    const until = active._max.endsAt;
    return active._count._all > 0 && until
      ? { activeShowtimeCount: active._count._all, until: until.toISOString() }
      : null;
  }

  /** One UPDATE for the whole batch (up to ~1000 seats with implicit partner changes). */
  private async writeSeats(
    tx: Prisma.TransactionClient,
    roomId: string,
    seats: { id: string; type: string; isActive: boolean; coupleGroup: number | null }[],
  ): Promise<void> {
    if (seats.length === 0) return;
    const values = Prisma.join(
      seats.map(
        (seat) =>
          Prisma.sql`(${seat.id}::uuid, ${seat.type}::seat_type, ${seat.isActive}::boolean, ${seat.coupleGroup}::int)`,
      ),
    );
    const updated = await tx.$executeRaw`
      UPDATE seats AS s
      SET type = v.type, is_active = v.is_active, couple_group = v.couple_group,
          updated_at = ${this.clock.now()}
      FROM (VALUES ${values}) AS v(id, type, is_active, couple_group)
      WHERE s.id = v.id AND s.room_id = ${roomId}::uuid`;
    // The room is locked and seats are only deleted with their room, so this cannot happen.
    if (updated !== seats.length) {
      throw new Error(`Seat update touched ${updated} rows, expected ${seats.length}`);
    }
  }
}
