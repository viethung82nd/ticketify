import { z } from 'zod';
import { VoucherDiscountType } from '../enums.js';
import { formatVnd } from './pricing.js';
import { isIsoInstant } from './showtime.js';

/**
 * Limits shared by the API DTOs and the web form so both validate the same way (ROADMAP 5.1).
 * The database CHECKs (`*_vouchers` migration) hold the looser rules underneath: code format,
 * PERCENT 1–100, positive amounts and limits, endsAt after startsAt.
 */
export const VOUCHER_LIMITS = {
  codeMin: 4,
  codeMax: 20,
  descriptionMax: 500,
  /** PERCENT: % of the subtotal. */
  percentMin: 1,
  percentMax: 100,
  /** FIXED: VND off the subtotal. */
  fixedMin: 1_000,
  fixedMax: 1_000_000,
  /** VND cap of a PERCENT voucher. */
  maxDiscountMin: 1_000,
  maxDiscountMax: 1_000_000,
  /** VND. */
  minSubtotalMax: 10_000_000,
  usageLimitMax: 1_000_000,
  perUserLimitMax: 100,
  /** `perUserLimit` when a create request leaves it out (`null` = unlimited). */
  perUserLimitDefault: 1,
} as const;

/** Upper-case letters and digits only; what the user typed is trimmed and upper-cased first. */
export const VOUCHER_CODE_PATTERN = /^[A-Z0-9]+$/;

/** `" summer10 "` → `"SUMMER10"`. Applied by the API and the form before validating. */
export const normalizeVoucherCode = (code: string): string => code.trim().toUpperCase();

/** The fields whose rules depend on each other. */
export interface VoucherRuleInput {
  discountType: VoucherDiscountType;
  discountValue: number;
  maxDiscount: number | null;
  /** ISO 8601 with offset. */
  startsAt: string;
  endsAt: string;
}

/**
 * The rules that need more than one field: the discount range depends on the type, a cap only
 * makes sense for PERCENT, and the voucher must end after it starts. The API runs this on the
 * voucher as it would be after the request (a PATCH merged with the stored row) and answers
 * `400 VALIDATION_FAILED` with these fields; the web form runs it before sending.
 */
export function voucherRuleErrors(voucher: VoucherRuleInput): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const { discountType, discountValue, maxDiscount } = voucher;
  if (discountType === VoucherDiscountType.PERCENT) {
    if (discountValue < VOUCHER_LIMITS.percentMin || discountValue > VOUCHER_LIMITS.percentMax) {
      errors.push({
        field: 'discountValue',
        message: `Giảm theo phần trăm từ ${VOUCHER_LIMITS.percentMin} đến ${VOUCHER_LIMITS.percentMax}`,
      });
    }
  } else {
    if (discountValue < VOUCHER_LIMITS.fixedMin || discountValue > VOUCHER_LIMITS.fixedMax) {
      errors.push({
        field: 'discountValue',
        message: `Số tiền giảm từ ${formatVnd(VOUCHER_LIMITS.fixedMin)} ₫ đến ${formatVnd(VOUCHER_LIMITS.fixedMax)} ₫`,
      });
    }
    if (maxDiscount !== null) {
      errors.push({
        field: 'maxDiscount',
        message: 'Chỉ voucher giảm theo phần trăm mới có mức giảm tối đa',
      });
    }
  }
  if (Date.parse(voucher.endsAt) <= Date.parse(voucher.startsAt)) {
    errors.push({ field: 'endsAt', message: 'Thời điểm kết thúc phải sau thời điểm bắt đầu' });
  }
  return errors;
}

// ─── Requests ───

const codeSchema = z
  .string({ error: 'Vui lòng nhập mã voucher' })
  .transform(normalizeVoucherCode)
  .pipe(
    z
      .string()
      .min(VOUCHER_LIMITS.codeMin, { error: `Mã voucher từ ${VOUCHER_LIMITS.codeMin} ký tự` })
      .max(VOUCHER_LIMITS.codeMax, { error: `Mã voucher tối đa ${VOUCHER_LIMITS.codeMax} ký tự` })
      .regex(VOUCHER_CODE_PATTERN, { error: 'Mã voucher chỉ gồm chữ không dấu và số' }),
  );

/** Optional free text; blank becomes `null`. */
const descriptionSchema = z
  .string()
  .trim()
  .max(VOUCHER_LIMITS.descriptionMax, {
    error: `Mô tả tối đa ${VOUCHER_LIMITS.descriptionMax} ký tự`,
  })
  .transform((value) => (value === '' ? null : value))
  .nullable();

const intIn = (min: number, max: number, message: string) =>
  z
    .number({ error: message })
    .int({ error: message })
    .min(min, { error: message })
    .max(max, { error: message });

/** Before the type is known, any value either type allows; `voucherRuleErrors` narrows it. */
const discountValueSchema = intIn(
  VOUCHER_LIMITS.percentMin,
  VOUCHER_LIMITS.fixedMax,
  'Vui lòng nhập mức giảm hợp lệ',
);

const maxDiscountSchema = intIn(
  VOUCHER_LIMITS.maxDiscountMin,
  VOUCHER_LIMITS.maxDiscountMax,
  `Mức giảm tối đa từ ${formatVnd(VOUCHER_LIMITS.maxDiscountMin)} ₫ đến ${formatVnd(VOUCHER_LIMITS.maxDiscountMax)} ₫`,
).nullable();

const minSubtotalSchema = intIn(
  0,
  VOUCHER_LIMITS.minSubtotalMax,
  `Đơn tối thiểu từ 0 ₫ đến ${formatVnd(VOUCHER_LIMITS.minSubtotalMax)} ₫`,
);

const usageLimitSchema = intIn(
  1,
  VOUCHER_LIMITS.usageLimitMax,
  `Tổng số lượt từ 1 đến ${formatVnd(VOUCHER_LIMITS.usageLimitMax)}`,
).nullable();

const perUserLimitSchema = intIn(
  1,
  VOUCHER_LIMITS.perUserLimitMax,
  `Số lượt mỗi người từ 1 đến ${VOUCHER_LIMITS.perUserLimitMax}`,
).nullable();

const instantSchema = z.string().refine(isIsoInstant, {
  error: 'Thời điểm phải là ISO 8601 có múi giờ, ví dụ 2026-12-01T00:00:00+07:00',
});

const discountTypeSchema = z.enum([VoucherDiscountType.PERCENT, VoucherDiscountType.FIXED], {
  error: 'Vui lòng chọn kiểu giảm',
});

const voucherFields = {
  code: codeSchema,
  description: descriptionSchema.optional(),
  discountType: discountTypeSchema,
  discountValue: discountValueSchema,
  /** PERCENT only; `null` or left out = no cap. */
  maxDiscount: maxDiscountSchema.optional(),
  /** VND; 0 or left out = any subtotal. */
  minSubtotal: minSubtotalSchema.optional(),
  /** `null` or left out = unlimited. */
  usageLimit: usageLimitSchema.optional(),
  /** `null` = unlimited; left out = `VOUCHER_LIMITS.perUserLimitDefault`. */
  perUserLimit: perUserLimitSchema.optional(),
  startsAt: instantSchema,
  endsAt: instantSchema,
  isActive: z.boolean().optional(),
};

/**
 * `POST /admin/vouchers`. The code is stored upper-case and is unique (`409 VOUCHER_CODE_TAKEN`);
 * "summer10" and "SUMMER10" are the same code.
 */
export const createVoucherRequestSchema = z.object(voucherFields).superRefine((voucher, ctx) => {
  const errors = voucherRuleErrors({ ...voucher, maxDiscount: voucher.maxDiscount ?? null });
  for (const { field, message } of errors) {
    ctx.addIssue({ code: 'custom', path: [field], message });
  }
});
export type CreateVoucherRequest = z.input<typeof createVoucherRequestSchema>;

/**
 * `PATCH /admin/vouchers/:id`: only the fields sent change. The rules across fields are checked
 * by the API on the merged voucher. The code cannot change once a booking used the voucher
 * (`409 VOUCHER_IN_USE`).
 */
export const updateVoucherRequestSchema = z.object({
  code: codeSchema.optional(),
  description: descriptionSchema.optional(),
  discountType: discountTypeSchema.optional(),
  discountValue: discountValueSchema.optional(),
  maxDiscount: maxDiscountSchema.optional(),
  minSubtotal: minSubtotalSchema.optional(),
  usageLimit: usageLimitSchema.optional(),
  perUserLimit: perUserLimitSchema.optional(),
  startsAt: instantSchema.optional(),
  endsAt: instantSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateVoucherRequest = z.input<typeof updateVoucherRequestSchema>;

// ─── Responses ───

/** Uses of a voucher by status, counted from `voucher_usages`. */
export const voucherUsageCountsSchema = z.object({
  reserved: z.number().int(),
  consumed: z.number().int(),
  released: z.number().int(),
});
export type VoucherUsageCounts = z.infer<typeof voucherUsageCountsSchema>;

/** `GET /admin/vouchers`, newest first; also the body of the create and update answers. */
export const adminVoucherSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  description: z.string().nullable(),
  discountType: discountTypeSchema,
  discountValue: z.number().int(),
  maxDiscount: z.number().int().nullable(),
  minSubtotal: z.number().int(),
  usageLimit: z.number().int().nullable(),
  perUserLimit: z.number().int().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  isActive: z.boolean(),
  /** RESERVED + CONSUMED count against the limits; any use at all blocks deleting. */
  usage: voucherUsageCountsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminVoucher = z.infer<typeof adminVoucherSchema>;

/** Machine-readable `code` values of voucher API errors. */
export const VoucherErrorCode = {
  VOUCHER_NOT_FOUND: 'VOUCHER_NOT_FOUND',
  /** 409: another voucher has this code (codes are compared upper-cased). */
  VOUCHER_CODE_TAKEN: 'VOUCHER_CODE_TAKEN',
  /**
   * 409: a booking used the voucher, so it cannot be deleted (switch it off with
   * `isActive: false`) and its code cannot change. `details.usageCount`.
   */
  VOUCHER_IN_USE: 'VOUCHER_IN_USE',
} as const;
export type VoucherErrorCode = (typeof VoucherErrorCode)[keyof typeof VoucherErrorCode];
