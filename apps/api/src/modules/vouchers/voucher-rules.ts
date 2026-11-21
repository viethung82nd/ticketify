import { VOUCHER_LIMITS, VoucherDiscountType, VoucherErrorCode } from '@ticketify/shared';

/** The terms of a voucher a hold is checked against (a `vouchers` row). */
export interface VoucherTerms {
  discountType: VoucherDiscountType;
  /** PERCENT: 1–100; FIXED: VND. */
  discountValue: number;
  /** VND cap of a PERCENT discount; `null` = no cap. */
  maxDiscount: number | null;
  /** VND; 0 = any subtotal. */
  minSubtotal: number;
  /** Uses across all users (RESERVED + CONSUMED); `null` = unlimited. */
  usageLimit: number | null;
  /** Uses per user (RESERVED + CONSUMED); `null` = unlimited. */
  perUserLimit: number | null;
  startsAt: Date;
  /** Exclusive. */
  endsAt: Date;
  isActive: boolean;
}

/** Uses that count against the limits: RESERVED + CONSUMED, never RELEASED. */
export interface VoucherUseCounts {
  total: number;
  byUser: number;
}

/** Why a voucher does not apply, with the `details` the API answers with. */
export type VoucherRefusal =
  | { code: typeof VoucherErrorCode.VOUCHER_NOT_AVAILABLE }
  | { code: typeof VoucherErrorCode.VOUCHER_NOT_IN_EFFECT; startsAt: Date; endsAt: Date }
  | {
      code: typeof VoucherErrorCode.VOUCHER_MIN_SUBTOTAL_NOT_MET;
      minSubtotal: number;
      subtotal: number;
    }
  | { code: typeof VoucherErrorCode.VOUCHER_USAGE_LIMIT_REACHED; usageLimit: number }
  | { code: typeof VoucherErrorCode.VOUCHER_USER_LIMIT_REACHED; perUserLimit: number };

/**
 * The discount the voucher's own formula gives, before the payable floor: PERCENT is
 * `floor(subtotal × value / 100)`, capped at `maxDiscount` when there is one; FIXED is the value,
 * never more than the subtotal. Whole VND, never negative.
 */
export function rawDiscount(
  voucher: Pick<VoucherTerms, 'discountType' | 'discountValue' | 'maxDiscount'>,
  subtotal: number,
): number {
  if (subtotal <= 0) return 0;
  if (voucher.discountType === VoucherDiscountType.PERCENT) {
    const percent = Math.floor((subtotal * voucher.discountValue) / 100);
    return voucher.maxDiscount === null ? percent : Math.min(percent, voucher.maxDiscount);
  }
  return Math.min(voucher.discountValue, subtotal);
}

/**
 * The smallest subtotal the voucher applies to: its own `minSubtotal`, or just above the payable
 * floor (`VOUCHER_LIMITS.payableTotalMin`) when that is higher, since below it there is nothing
 * left to take off.
 */
export function effectiveMinSubtotal(voucher: Pick<VoucherTerms, 'minSubtotal'>): number {
  return Math.max(voucher.minSubtotal, VOUCHER_LIMITS.payableTotalMin + 1);
}

/**
 * The discount a booking gets: `rawDiscount`, capped so the total stays at or above
 * `VOUCHER_LIMITS.payableTotalMin` (a total of 0 cannot be paid through VNPay). At least 1 VND
 * whenever `effectiveMinSubtotal` is met: PERCENT is at least 1 % and FIXED at least 1 000 ₫.
 */
export function voucherDiscount(
  voucher: Pick<VoucherTerms, 'discountType' | 'discountValue' | 'maxDiscount'>,
  subtotal: number,
): number {
  const ceiling = subtotal - VOUCHER_LIMITS.payableTotalMin;
  return Math.max(0, Math.min(rawDiscount(voucher, subtotal), ceiling));
}

/**
 * The checks that need only the voucher row and the request, in the order the API reports them:
 * switched off, outside `startsAt <= now < endsAt`, subtotal too small. `null` = they pass.
 */
export function voucherTermsRefusal(
  voucher: VoucherTerms,
  now: Date,
  subtotal: number,
): VoucherRefusal | null {
  if (!voucher.isActive) return { code: VoucherErrorCode.VOUCHER_NOT_AVAILABLE };
  const at = now.getTime();
  if (at < voucher.startsAt.getTime() || at >= voucher.endsAt.getTime()) {
    return {
      code: VoucherErrorCode.VOUCHER_NOT_IN_EFFECT,
      startsAt: voucher.startsAt,
      endsAt: voucher.endsAt,
    };
  }
  const minSubtotal = effectiveMinSubtotal(voucher);
  if (subtotal < minSubtotal) {
    return { code: VoucherErrorCode.VOUCHER_MIN_SUBTOTAL_NOT_MET, minSubtotal, subtotal };
  }
  return null;
}

/**
 * The limits, from the uses counted under the voucher's row lock: one more use must fit both.
 * The total limit is reported first.
 */
export function voucherLimitRefusal(
  voucher: Pick<VoucherTerms, 'usageLimit' | 'perUserLimit'>,
  used: VoucherUseCounts,
): VoucherRefusal | null {
  if (voucher.usageLimit !== null && used.total >= voucher.usageLimit) {
    return { code: VoucherErrorCode.VOUCHER_USAGE_LIMIT_REACHED, usageLimit: voucher.usageLimit };
  }
  if (voucher.perUserLimit !== null && used.byUser >= voucher.perUserLimit) {
    return {
      code: VoucherErrorCode.VOUCHER_USER_LIMIT_REACHED,
      perUserLimit: voucher.perUserLimit,
    };
  }
  return null;
}
