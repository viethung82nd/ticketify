import { VOUCHER_LIMITS, VoucherDiscountType } from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import {
  effectiveMinSubtotal,
  rawDiscount,
  voucherDiscount,
  voucherLimitRefusal,
  type VoucherTerms,
  voucherTermsRefusal,
} from './voucher-rules';

const at = (iso: string): Date => new FakeClock(iso).now();
const FLOOR = VOUCHER_LIMITS.payableTotalMin;

const percent = (value: number, maxDiscount: number | null = null) => ({
  discountType: VoucherDiscountType.PERCENT,
  discountValue: value,
  maxDiscount,
});
const fixed = (value: number) => ({
  discountType: VoucherDiscountType.FIXED,
  discountValue: value,
  maxDiscount: null,
});

const terms = (overrides: Partial<VoucherTerms> = {}): VoucherTerms => ({
  ...percent(10),
  minSubtotal: 0,
  usageLimit: null,
  perUserLimit: 1,
  startsAt: at('2026-11-01T00:00:00.000Z'),
  endsAt: at('2026-12-01T00:00:00.000Z'),
  isActive: true,
  ...overrides,
});

describe('rawDiscount', () => {
  it.each([
    ['10 % of 180 000', percent(10), 180_000, 18_000],
    ['rounds down: 15 % of 99 999', percent(15), 99_999, 14_999],
    ['rounds down: 1 % of 1 999', percent(1), 1_999, 19],
    ['100 % is the whole subtotal', percent(100), 180_000, 180_000],
    ['cap below the percentage wins', percent(50, 30_000), 180_000, 30_000],
    ['cap above the percentage changes nothing', percent(10, 30_000), 180_000, 18_000],
    ['cap equal to the percentage', percent(10, 18_000), 180_000, 18_000],
    ['FIXED below the subtotal', fixed(20_000), 180_000, 20_000],
    ['FIXED equal to the subtotal', fixed(90_000), 90_000, 90_000],
    ['FIXED above the subtotal is the subtotal', fixed(100_000), 90_000, 90_000],
    ['nothing off a subtotal of 0', fixed(20_000), 0, 0],
  ] as const)('%s', (_label, voucher, subtotal, expected) => {
    expect(rawDiscount(voucher, subtotal)).toBe(expected);
  });

  it('always an integer, never negative, never above the subtotal', () => {
    for (let subtotal = 0; subtotal <= 20_000; subtotal += 777) {
      for (const voucher of [percent(1), percent(33), percent(100, 5_000), fixed(1_000)]) {
        const discount = rawDiscount(voucher, subtotal);
        expect(Number.isInteger(discount)).toBe(true);
        expect(discount).toBeGreaterThanOrEqual(0);
        expect(discount).toBeLessThanOrEqual(subtotal);
      }
    }
  });
});

describe('voucherDiscount (payable floor)', () => {
  it('leaves the formula alone when the total stays above the floor', () => {
    expect(voucherDiscount(percent(10, 30_000), 180_000)).toBe(18_000);
    expect(voucherDiscount(fixed(20_000), 180_000)).toBe(20_000);
  });

  it(`never takes the total below ${FLOOR} ₫: 100 %, or FIXED ≥ subtotal`, () => {
    expect(voucherDiscount(percent(100), 180_000)).toBe(180_000 - FLOOR);
    expect(voucherDiscount(fixed(90_000), 90_000)).toBe(90_000 - FLOOR);
    expect(voucherDiscount(fixed(1_000_000), 90_000)).toBe(90_000 - FLOOR);
  });

  it('at least 1 ₫ off from the effective minimum subtotal up, for the smallest vouchers', () => {
    const min = effectiveMinSubtotal({ minSubtotal: 0 });
    expect(voucherDiscount(percent(1), min)).toBeGreaterThanOrEqual(1);
    expect(voucherDiscount(fixed(VOUCHER_LIMITS.fixedMin), min)).toBeGreaterThanOrEqual(1);
  });

  it('total = subtotal − discount stays a payable whole number', () => {
    for (let subtotal = FLOOR + 1; subtotal <= 400_000; subtotal += 3_333) {
      for (const voucher of [percent(1), percent(50, 40_000), percent(100), fixed(200_000)]) {
        const discount = voucherDiscount(voucher, subtotal);
        expect(Number.isInteger(discount)).toBe(true);
        expect(discount).toBeGreaterThanOrEqual(1);
        expect(subtotal - discount).toBeGreaterThanOrEqual(FLOOR);
      }
    }
  });
});

describe('effectiveMinSubtotal', () => {
  it("is the voucher's own minimum when above the floor", () => {
    expect(effectiveMinSubtotal({ minSubtotal: 200_000 })).toBe(200_000);
  });
  it('is just above the floor otherwise', () => {
    expect(effectiveMinSubtotal({ minSubtotal: 0 })).toBe(FLOOR + 1);
    expect(effectiveMinSubtotal({ minSubtotal: FLOOR })).toBe(FLOOR + 1);
  });
});

describe('voucherTermsRefusal', () => {
  const NOW = at('2026-11-15T10:00:00.000Z');

  it('passes an active voucher in effect with a large enough subtotal', () => {
    expect(voucherTermsRefusal(terms(), NOW, 180_000)).toBeNull();
  });

  it('switched off → VOUCHER_NOT_AVAILABLE, before anything else', () => {
    const voucher = terms({ isActive: false, startsAt: at('2027-01-01T00:00:00.000Z') });
    expect(voucherTermsRefusal(voucher, NOW, 0)).toEqual({ code: 'VOUCHER_NOT_AVAILABLE' });
  });

  it('startsAt is inclusive, endsAt exclusive', () => {
    const voucher = terms();
    expect(voucherTermsRefusal(voucher, voucher.startsAt, 180_000)).toBeNull();
    expect(voucherTermsRefusal(voucher, at('2026-11-30T23:59:59.999Z'), 180_000)).toBeNull();
    for (const now of [at('2026-10-31T23:59:59.999Z'), voucher.endsAt]) {
      expect(voucherTermsRefusal(voucher, now, 180_000)).toEqual({
        code: 'VOUCHER_NOT_IN_EFFECT',
        startsAt: voucher.startsAt,
        endsAt: voucher.endsAt,
      });
    }
  });

  it('subtotal below minSubtotal → VOUCHER_MIN_SUBTOTAL_NOT_MET with both amounts', () => {
    const voucher = terms({ minSubtotal: 200_000 });
    expect(voucherTermsRefusal(voucher, NOW, 199_999)).toEqual({
      code: 'VOUCHER_MIN_SUBTOTAL_NOT_MET',
      minSubtotal: 200_000,
      subtotal: 199_999,
    });
    expect(voucherTermsRefusal(voucher, NOW, 200_000)).toBeNull();
  });

  it('a subtotal at the payable floor gets no voucher, even with minSubtotal 0', () => {
    expect(voucherTermsRefusal(terms(), NOW, FLOOR)).toEqual({
      code: 'VOUCHER_MIN_SUBTOTAL_NOT_MET',
      minSubtotal: FLOOR + 1,
      subtotal: FLOOR,
    });
  });
});

describe('voucherLimitRefusal', () => {
  it('passes while one more use fits both limits', () => {
    expect(
      voucherLimitRefusal({ usageLimit: 10, perUserLimit: 2 }, { total: 9, byUser: 1 }),
    ).toBeNull();
  });

  it('null limits are unlimited', () => {
    expect(
      voucherLimitRefusal({ usageLimit: null, perUserLimit: null }, { total: 1e6, byUser: 1e3 }),
    ).toBeNull();
  });

  it('the last use taken → VOUCHER_USAGE_LIMIT_REACHED, reported before the per-user limit', () => {
    expect(
      voucherLimitRefusal({ usageLimit: 10, perUserLimit: 1 }, { total: 10, byUser: 1 }),
    ).toEqual({ code: 'VOUCHER_USAGE_LIMIT_REACHED', usageLimit: 10 });
  });

  it("the user's uses taken → VOUCHER_USER_LIMIT_REACHED", () => {
    expect(
      voucherLimitRefusal({ usageLimit: null, perUserLimit: 2 }, { total: 5, byUser: 2 }),
    ).toEqual({ code: 'VOUCHER_USER_LIMIT_REACHED', perUserLimit: 2 });
  });
});
