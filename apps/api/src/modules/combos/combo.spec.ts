import {
  COMBO_LIMITS,
  createComboRequestSchema,
  updateComboRequestSchema,
} from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { comboNameKey } from './combo-name';
import { CreateComboDto, UpdateComboDto } from './dto/combo.dto';

type DtoClass<T> = new () => T;

/** Same options as the global ValidationPipe. */
function check<T extends object>(cls: DtoClass<T>, plain: object) {
  const instance = plainToInstance(cls, plain);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, invalid: errors.map((error) => error.property) };
}

describe('CreateComboDto (and the web schema, which must agree)', () => {
  it.each([COMBO_LIMITS.priceMin, 89_000, COMBO_LIMITS.priceMax])('accepts price %s', (price) => {
    const body = { name: 'Combo bắp nước', price };

    expect(check(CreateComboDto, body).invalid).toEqual([]);
    expect(createComboRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['below the minimum', COMBO_LIMITS.priceMin - 1],
    ['above the maximum', COMBO_LIMITS.priceMax + 1],
    ['not an integer', 89_000.5],
    ['zero', 0],
    ['a string', '89000'],
  ])('rejects a price %s', (_label, price) => {
    const body = { name: 'Combo bắp nước', price };

    expect(check(CreateComboDto, body).invalid).toEqual(['price']);
    expect(createComboRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['too long', 'x'.repeat(COMBO_LIMITS.nameMax + 1)],
  ])('rejects a name that is %s', (_label, name) => {
    const body = { name, price: 50_000 };

    expect(check(CreateComboDto, body).invalid).toEqual(['name']);
    expect(createComboRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a name of exactly the maximum length, trimmed', () => {
    const name = `  ${'x'.repeat(COMBO_LIMITS.nameMax)}  `;
    const { instance, invalid } = check(CreateComboDto, { name, price: 50_000 });

    expect(invalid).toEqual([]);
    expect(instance.name).toHaveLength(COMBO_LIMITS.nameMax);
  });

  it('stores a blank description as null and limits its length', () => {
    expect(
      check(CreateComboDto, { name: 'A', price: 50_000, description: '  ' }).instance.description,
    ).toBeNull();
    expect(
      check(CreateComboDto, {
        name: 'A',
        price: 50_000,
        description: 'x'.repeat(COMBO_LIMITS.descriptionMax + 1),
      }).invalid,
    ).toEqual(['description']);
  });
});

describe('UpdateComboDto', () => {
  it('accepts a partial body', () => {
    expect(check(UpdateComboDto, { isActive: false }).invalid).toEqual([]);
    expect(updateComboRequestSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('rejects null for name, price and isActive, and an out-of-range price', () => {
    expect(check(UpdateComboDto, { name: null, price: null, isActive: null }).invalid).toEqual([
      'name',
      'price',
      'isActive',
    ]);
    expect(check(UpdateComboDto, { price: COMBO_LIMITS.priceMax + 1 }).invalid).toEqual(['price']);
  });
});

describe('comboNameKey (duplicate names ignore case and diacritics)', () => {
  it.each([
    ['Bắp rang bơ', 'bap rang bo'],
    ['Bắp Rang Bơ', 'BẮP RANG BƠ'],
    ['Combo Đôi', 'combo doi'],
    ['  Nước   ngọt ', 'nuoc ngot'],
    // Same letters typed as base letter + combining marks (NFD).
    ['Bắp rang bơ', 'Bắp rang bơ'.normalize('NFD')],
  ])('"%s" and "%s" are the same name', (a, b) => {
    expect(comboNameKey(a)).toBe(comboNameKey(b));
  });

  it.each([
    ['Combo 1', 'Combo 2'],
    ['Bắp rang', 'Bắp rang bơ'],
  ])('"%s" and "%s" are different names', (a, b) => {
    expect(comboNameKey(a)).not.toBe(comboNameKey(b));
  });
});
