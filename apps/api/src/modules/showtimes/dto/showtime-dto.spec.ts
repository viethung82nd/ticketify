import { createShowtimeRequestSchema, isIsoInstant } from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateShowtimeDto, ListShowtimesQueryDto } from './showtime.dto';

type DtoClass<T> = new () => T;

/** Same options as the global ValidationPipe. */
function check<T extends object>(cls: DtoClass<T>, plain: object) {
  const errors = validateSync(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

const MOVIE = '01a17e75-7100-7679-b8b1-000000000001';
const ROOM = '01a17e75-7100-7679-b8b1-000000000002';

describe('CreateShowtimeDto (and the web schema, which must agree)', () => {
  it.each([
    '2026-11-02T19:30:00+07:00',
    '2026-11-02T19:30+07:00',
    '2026-11-02T12:30:00Z',
    '2026-11-02T12:30:00.123Z',
    '2026-11-02T00:00:00-05:30',
  ])('accepts startsAt %s', (startsAt) => {
    const body = { movieId: MOVIE, roomId: ROOM, startsAt };

    expect(check(CreateShowtimeDto, body)).toEqual([]);
    expect(createShowtimeRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['no offset (server-local time)', '2026-11-02T19:30:00'],
    ['a date only', '2026-11-02'],
    ['a day that does not exist', '2026-02-30T19:30:00+07:00'],
    ['hour 24', '2026-11-02T24:00:00+07:00'],
    ['offset beyond ±14:00', '2026-11-02T19:30:00+15:00'],
    ['a space instead of T', '2026-11-02 19:30:00+07:00'],
    ['epoch milliseconds', 1_793_633_400_000],
  ])('rejects startsAt with %s', (_label, startsAt) => {
    const body = { movieId: MOVIE, roomId: ROOM, startsAt };

    expect(check(CreateShowtimeDto, body)).toEqual(['startsAt']);
    expect(createShowtimeRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects malformed ids', () => {
    expect(
      check(CreateShowtimeDto, { movieId: 'x', roomId: 1, startsAt: '2026-11-02T12:30Z' }),
    ).toEqual(['movieId', 'roomId']);
  });

  it('isIsoInstant reads the parts it validates', () => {
    expect(isIsoInstant('2026-11-02T19:59:59+14:00')).toBe(true);
    expect(isIsoInstant('2026-11-02T19:60:00+07:00')).toBe(false);
  });
});

describe('ListShowtimesQueryDto', () => {
  it('requires movieId', () => {
    expect(check(ListShowtimesQueryDto, { date: '2026-11-02' })).toEqual(['movieId']);
  });

  it('takes an optional YYYY-MM-DD date', () => {
    expect(check(ListShowtimesQueryDto, { movieId: MOVIE })).toEqual([]);
    expect(check(ListShowtimesQueryDto, { movieId: MOVIE, date: '2026-11-02' })).toEqual([]);
    expect(check(ListShowtimesQueryDto, { movieId: MOVIE, date: '02/11/2026' })).toEqual(['date']);
  });
});
