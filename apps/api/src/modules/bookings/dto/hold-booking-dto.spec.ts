import { BOOKING_LIMITS, holdBookingRequestSchema, isIdempotencyKey } from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { HoldBookingDto } from './hold-booking.dto';

/** Same options as the global ValidationPipe. */
function check(plain: object) {
  const instance = plainToInstance(HoldBookingDto, plain);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, invalid: errors.map((error) => error.property) };
}

const SHOWTIME = '01a17e75-0000-7000-8000-00000000a001';
const SEAT = (n: number) => `01a17e75-7100-7679-b8b1-${String(n).padStart(12, '0')}`;
const COMBO = (n: number) => `01a17e75-c000-7000-8000-${String(n).padStart(12, '0')}`;
const seats = (n: number) => Array.from({ length: n }, (_, i) => SEAT(i + 1));

/** The DTO (API) and the zod schema (web) must agree on every case. */
function expectBoth(body: object, invalid: string[]) {
  expect(check(body).invalid).toEqual(invalid);
  expect(holdBookingRequestSchema.safeParse(body).success).toBe(invalid.length === 0);
}

describe('HoldBookingDto (and the web schema)', () => {
  it(`accepts 1 to ${BOOKING_LIMITS.seatsMax} seats, with or without combos`, () => {
    expectBoth({ showtimeId: SHOWTIME, seatIds: seats(1) }, []);
    expectBoth({ showtimeId: SHOWTIME, seatIds: seats(BOOKING_LIMITS.seatsMax) }, []);
    expectBoth(
      {
        showtimeId: SHOWTIME,
        seatIds: seats(2),
        comboItems: [
          { comboId: COMBO(1), quantity: 1 },
          { comboId: COMBO(2), quantity: BOOKING_LIMITS.comboQuantityMax },
        ],
      },
      [],
    );
  });

  it(`rejects more than ${BOOKING_LIMITS.seatsMax} seats`, () => {
    expectBoth({ showtimeId: SHOWTIME, seatIds: seats(BOOKING_LIMITS.seatsMax + 1) }, ['seatIds']);
  });

  it('rejects an empty or missing seat list', () => {
    expectBoth({ showtimeId: SHOWTIME, seatIds: [] }, ['seatIds']);
    expectBoth({ showtimeId: SHOWTIME }, ['seatIds']);
  });

  it('rejects the same seat twice, also when only the letter case differs', () => {
    expectBoth({ showtimeId: SHOWTIME, seatIds: [SEAT(1), SEAT(2), SEAT(1)] }, ['seatIds']);
    expectBoth({ showtimeId: SHOWTIME, seatIds: [SEAT(1).replace('b8b1', 'B8B1'), SEAT(1)] }, [
      'seatIds',
    ]);
  });

  it('rejects malformed ids', () => {
    expectBoth({ showtimeId: 'nope', seatIds: seats(1) }, ['showtimeId']);
    expectBoth({ showtimeId: SHOWTIME, seatIds: ['A1'] }, ['seatIds']);
  });

  it('rejects a combo listed twice, a quantity out of range, or too many lines', () => {
    const body = (comboItems: object[]) => ({
      showtimeId: SHOWTIME,
      seatIds: seats(1),
      comboItems,
    });
    expectBoth(
      body([
        { comboId: COMBO(1), quantity: 1 },
        { comboId: COMBO(1), quantity: 2 },
      ]),
      ['comboItems'],
    );
    for (const quantity of [0, BOOKING_LIMITS.comboQuantityMax + 1, 1.5]) {
      expectBoth(body([{ comboId: COMBO(1), quantity }]), ['comboItems']);
    }
    expectBoth(
      body(
        Array.from({ length: BOOKING_LIMITS.comboLinesMax + 1 }, (_, i) => ({
          comboId: COMBO(i),
          quantity: 1,
        })),
      ),
      ['comboItems'],
    );
  });

  it('lower-cases ids so they compare and hash the same', () => {
    const { instance } = check({
      showtimeId: SHOWTIME.toUpperCase(),
      seatIds: [SEAT(1).toUpperCase()],
      comboItems: [{ comboId: COMBO(1).toUpperCase(), quantity: 1 }],
    });

    expect(instance.showtimeId).toBe(SHOWTIME);
    expect(instance.seatIds).toEqual([SEAT(1)]);
    expect(instance.comboItems?.[0]?.comboId).toBe(COMBO(1));
  });
});

describe('isIdempotencyKey', () => {
  it.each([
    'abcdefgh',
    '0b9c1f4e-7a0d-4c4e-9a53-7e7f3a3c2d10',
    '01HZX3V5Q8K2M4N6P8R0T2V4X6',
    'retry:2026.11.01_~-1',
    'x'.repeat(BOOKING_LIMITS.idempotencyKeyMax),
  ])('accepts %p', (key) => {
    expect(isIdempotencyKey(key)).toBe(true);
  });

  it.each([
    ['too short', 'abcdefg'],
    ['too long', 'x'.repeat(BOOKING_LIMITS.idempotencyKeyMax + 1)],
    ['a space', 'abcd efgh'],
    ['a slash', 'abcd/efgh'],
    ['non-ASCII', 'khóa-đặt-vé'],
  ])('rejects %s', (_label, key) => {
    expect(isIdempotencyKey(key)).toBe(false);
  });
});
