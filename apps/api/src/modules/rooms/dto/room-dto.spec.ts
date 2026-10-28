import { createRoomRequestSchema, ROOM_LIMITS, updateSeatsRequestSchema } from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateRoomDto, RenameRoomDto, UpdateSeatsDto } from './room.dto';

type DtoClass<T> = new () => T;

/** Same options as the global ValidationPipe. */
function check<T extends object>(cls: DtoClass<T>, plain: object) {
  const instance = plainToInstance(cls, plain);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, invalid: errors.map((error) => error.property) };
}

const SEAT = (n: number) => `01a17e75-7100-7679-b8b1-${String(n).padStart(12, '0')}`;

describe('CreateRoomDto (and the web schema, which must agree)', () => {
  it.each([
    [1, 1],
    [10, 12],
    [ROOM_LIMITS.rowsMax, ROOM_LIMITS.colsMax],
  ])('accepts %s rows × %s cols', (rows, cols) => {
    const body = { name: 'Phòng 1', rows, cols };

    expect(check(CreateRoomDto, body).invalid).toEqual([]);
    expect(createRoomRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['rows', 0],
    ['rows', 27],
    ['rows', 2.5],
    ['rows', '10'],
    ['cols', 0],
    ['cols', 31],
    ['cols', null],
  ])('rejects %s = %p', (field, value) => {
    const body = { name: 'Phòng 1', rows: 10, cols: 12, [field]: value };

    expect(check(CreateRoomDto, body).invalid).toEqual([field]);
    expect(createRoomRequestSchema.safeParse(body).success).toBe(false);
  });

  it('trims the name and rejects a blank or too long one', () => {
    expect(check(CreateRoomDto, { name: '  Phòng VIP ', rows: 1, cols: 1 }).instance.name).toBe(
      'Phòng VIP',
    );
    for (const name of ['   ', 'x'.repeat(ROOM_LIMITS.nameMax + 1)]) {
      expect(check(RenameRoomDto, { name }).invalid).toEqual(['name']);
    }
  });
});

describe('UpdateSeatsDto (and the web schema)', () => {
  const changes = (n: number) => Array.from({ length: n }, (_, i) => ({ seatId: SEAT(i) }));

  it(`accepts 1 to ${ROOM_LIMITS.seatChangesMax} changes`, () => {
    for (const n of [1, ROOM_LIMITS.seatChangesMax]) {
      expect(check(UpdateSeatsDto, { changes: changes(n) }).invalid).toEqual([]);
      expect(updateSeatsRequestSchema.safeParse({ changes: changes(n) }).success).toBe(true);
    }
  });

  it.each([
    ['no changes', []],
    [`${ROOM_LIMITS.seatChangesMax + 1} changes`, changes(ROOM_LIMITS.seatChangesMax + 1)],
    ['a duplicated seat', [{ seatId: SEAT(1) }, { seatId: SEAT(1), type: 'VIP' }]],
  ])('rejects %s', (_case, list) => {
    expect(check(UpdateSeatsDto, { changes: list }).invalid).toEqual(['changes']);
    expect(updateSeatsRequestSchema.safeParse({ changes: list }).success).toBe(false);
  });

  it.each([
    ['a malformed seat id', { seatId: 'A1' }],
    ['an unknown type', { seatId: SEAT(1), type: 'SOFA' }],
    ['type null', { seatId: SEAT(1), type: null }],
    ['isActive as a string', { seatId: SEAT(1), isActive: 'true' }],
    ['a malformed coupleWith', { seatId: SEAT(1), coupleWith: 'A2' }],
  ])('rejects %s', (_case, change) => {
    expect(check(UpdateSeatsDto, { changes: [change] }).invalid).toEqual(['changes']);
    expect(updateSeatsRequestSchema.safeParse({ changes: [change] }).success).toBe(false);
  });

  it('rejects unknown fields and non-object items without throwing', () => {
    expect(check(UpdateSeatsDto, { changes: [{ seatId: SEAT(1), price: 1 }] }).invalid).toEqual([
      'changes',
    ]);
    expect(check(UpdateSeatsDto, { changes: [null] }).invalid).toEqual(['changes']);
    expect(check(UpdateSeatsDto, { changes: 'all' }).invalid).toEqual(['changes']);
  });

  it('accepts coupleWith null (leave the pair) and every field together', () => {
    const change = { seatId: SEAT(1), type: 'COUPLE', isActive: false, coupleWith: null };

    expect(check(UpdateSeatsDto, { changes: [change] }).invalid).toEqual([]);
    expect(updateSeatsRequestSchema.safeParse({ changes: [change] }).success).toBe(true);
  });
});
