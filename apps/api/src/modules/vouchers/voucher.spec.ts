import {
  createVoucherRequestSchema,
  updateVoucherRequestSchema,
  VOUCHER_LIMITS,
  voucherRuleErrors,
} from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateVoucherDto, UpdateVoucherDto } from './dto/voucher.dto';

type DtoClass<T> = new () => T;

/** Same options as the global ValidationPipe. */
function check<T extends object>(cls: DtoClass<T>, plain: object) {
  const instance = plainToInstance(cls, plain);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, invalid: errors.map((error) => error.property) };
}

const VALID = {
  code: 'SUMMER10',
  discountType: 'PERCENT',
  discountValue: 10,
  startsAt: '2026-12-01T00:00:00+07:00',
  endsAt: '2027-01-01T00:00:00+07:00',
} as const;

describe('CreateVoucherDto (and the web schema, which must agree)', () => {
  it('accepts the smallest valid body', () => {
    expect(check(CreateVoucherDto, VALID).invalid).toEqual([]);
    expect(createVoucherRequestSchema.safeParse(VALID).success).toBe(true);
  });

  it('trims and upper-cases the code before checking it', () => {
    const body = { ...VALID, code: '  summer10 ' };

    expect(check(CreateVoucherDto, body).instance.code).toBe('SUMMER10');
    expect(createVoucherRequestSchema.parse(body).code).toBe('SUMMER10');
  });

  it.each([
    ['too short', 'AB1'],
    ['too long', 'A'.repeat(VOUCHER_LIMITS.codeMax + 1)],
    ['a hyphen', 'SUMMER-10'],
    ['a space inside', 'SUMMER 10'],
    ['a Vietnamese letter', 'GIẢMGIÁ'],
    ['not a string', 12345],
  ])('rejects a code with %s', (_label, code) => {
    const body = { ...VALID, code };

    expect(check(CreateVoucherDto, body).invalid).toEqual(['code']);
    expect(createVoucherRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['an unknown type', { discountType: 'BOGO' }, ['discountType']],
    ['a value of 0', { discountValue: 0 }, ['discountValue']],
    ['a value above any type', { discountValue: VOUCHER_LIMITS.fixedMax + 1 }, ['discountValue']],
    ['a fractional value', { discountValue: 10.5 }, ['discountValue']],
    [
      'a cap below the minimum',
      { maxDiscount: VOUCHER_LIMITS.maxDiscountMin - 1 },
      ['maxDiscount'],
    ],
    ['a negative min subtotal', { minSubtotal: -1 }, ['minSubtotal']],
    ['a null min subtotal', { minSubtotal: null }, ['minSubtotal']],
    ['a usage limit of 0', { usageLimit: 0 }, ['usageLimit']],
    ['a per-user limit above the maximum', { perUserLimit: 101 }, ['perUserLimit']],
    ['a date without offset', { startsAt: '2026-12-01T00:00:00' }, ['startsAt']],
    ['a date only', { endsAt: '2027-01-01' }, ['endsAt']],
    ['a null isActive', { isActive: null }, ['isActive']],
  ])('rejects %s', (_label, change, fields) => {
    const body = { ...VALID, ...change };

    expect(check(CreateVoucherDto, body).invalid).toEqual(fields);
    expect(createVoucherRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts null for the nullable limits and the cap', () => {
    const body = { ...VALID, maxDiscount: null, usageLimit: null, perUserLimit: null };

    expect(check(CreateVoucherDto, body).invalid).toEqual([]);
    expect(createVoucherRequestSchema.safeParse(body).success).toBe(true);
  });

  it('stores a blank description as null', () => {
    expect(
      check(CreateVoucherDto, { ...VALID, description: '  ' }).instance.description,
    ).toBeNull();
  });

  it('rejects unknown fields', () => {
    expect(check(CreateVoucherDto, { ...VALID, usedCount: 3 }).invalid).toEqual(['usedCount']);
  });
});

describe('voucherRuleErrors (the rules across fields)', () => {
  const rule = (change: object) =>
    voucherRuleErrors({ ...VALID, maxDiscount: null, ...change }).map((error) => error.field);

  it.each([
    ['PERCENT 1', { discountValue: 1 }],
    ['PERCENT 100 with a cap', { discountValue: 100, maxDiscount: 50_000 }],
    ['FIXED at the minimum', { discountType: 'FIXED', discountValue: VOUCHER_LIMITS.fixedMin }],
    ['FIXED at the maximum', { discountType: 'FIXED', discountValue: VOUCHER_LIMITS.fixedMax }],
  ])('accepts %s', (_label, change) => {
    expect(rule(change)).toEqual([]);
  });

  it.each([
    ['PERCENT above 100', { discountValue: 101 }, ['discountValue']],
    ['FIXED below the minimum', { discountType: 'FIXED', discountValue: 500 }, ['discountValue']],
    [
      'FIXED with a cap',
      { discountType: 'FIXED', discountValue: 20_000, maxDiscount: 10_000 },
      ['maxDiscount'],
    ],
    ['an end equal to the start', { endsAt: VALID.startsAt }, ['endsAt']],
    ['an end before the start', { endsAt: '2026-11-30T23:59:59+07:00' }, ['endsAt']],
    // Same instant written in two offsets: the order is by instant, not by text.
    ['an end that is the start in another offset', { endsAt: '2026-11-30T17:00:00Z' }, ['endsAt']],
  ])('rejects %s', (_label, change, fields) => {
    expect(rule(change)).toEqual(fields);
  });

  it('is what the web schema reports, with the same fields', () => {
    const body = { ...VALID, discountType: 'FIXED', discountValue: 500, maxDiscount: 10_000 };
    const result = createVoucherRequestSchema.safeParse(body);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'discountValue',
      'maxDiscount',
    ]);
  });
});

describe('UpdateVoucherDto', () => {
  it('accepts a partial body', () => {
    expect(check(UpdateVoucherDto, { isActive: false }).invalid).toEqual([]);
    expect(updateVoucherRequestSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('accepts null where null clears a value', () => {
    const body = { description: null, maxDiscount: null, usageLimit: null, perUserLimit: null };

    expect(check(UpdateVoucherDto, body).invalid).toEqual([]);
    expect(updateVoucherRequestSchema.safeParse(body).success).toBe(true);
  });

  it('rejects null where a value is required', () => {
    const body = {
      code: null,
      discountType: null,
      discountValue: null,
      minSubtotal: null,
      startsAt: null,
      endsAt: null,
      isActive: null,
    };

    expect(check(UpdateVoucherDto, body).invalid).toEqual(Object.keys(body));
    expect(updateVoucherRequestSchema.safeParse(body).success).toBe(false);
  });

  it('normalizes a new code like create does', () => {
    expect(check(UpdateVoucherDto, { code: 'tet2027' }).instance.code).toBe('TET2027');
  });
});
