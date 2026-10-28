import { z } from 'zod';
import { formatVnd } from './pricing.js';

/** Limits shared by the API DTOs and the web forms so both validate the same way. */
export const COMBO_LIMITS = {
  nameMax: 100,
  descriptionMax: 500,
  /** VND. */
  priceMin: 1_000,
  priceMax: 500_000,
} as const;

const priceRangeMessage = `Giá từ ${formatVnd(COMBO_LIMITS.priceMin)} ₫ đến ${formatVnd(COMBO_LIMITS.priceMax)} ₫`;

// ─── Requests ───

const nameSchema = z
  .string({ error: 'Vui lòng nhập tên combo' })
  .trim()
  .min(1, { error: 'Vui lòng nhập tên combo' })
  .max(COMBO_LIMITS.nameMax, { error: `Tên combo tối đa ${COMBO_LIMITS.nameMax} ký tự` });

const priceSchema = z
  .number({ error: 'Vui lòng nhập giá' })
  .int({ error: 'Giá phải là số nguyên (VND)' })
  .min(COMBO_LIMITS.priceMin, { error: priceRangeMessage })
  .max(COMBO_LIMITS.priceMax, { error: priceRangeMessage });

/** Optional free text; blank becomes `null`. */
const descriptionSchema = z
  .string()
  .trim()
  .max(COMBO_LIMITS.descriptionMax, {
    error: `Mô tả tối đa ${COMBO_LIMITS.descriptionMax} ký tự`,
  })
  .transform((value) => (value === '' ? null : value))
  .nullable();

/**
 * `POST /admin/combos`. Names are unique ignoring case and Vietnamese diacritics
 * ("Bắp rang" = "bap RANG", `409 COMBO_NAME_TAKEN`).
 */
export const createComboRequestSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  price: priceSchema,
  isActive: z.boolean().optional(),
});
export type CreateComboRequest = z.input<typeof createComboRequestSchema>;

/** `PATCH /admin/combos/:id`: only the fields sent change. */
export const updateComboRequestSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  price: priceSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateComboRequest = z.input<typeof updateComboRequestSchema>;

// ─── Responses ───

/** `GET /combos`: active combos only, by Vietnamese name order. */
export const comboSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /** VND. Bookings copy name and price, so later edits never change an existing order. */
  price: z.number().int(),
});
export type Combo = z.infer<typeof comboSchema>;

/** `GET /admin/combos`: every combo. */
export const adminComboSchema = comboSchema.extend({
  isActive: z.boolean(),
  /** Booking lines that reference the combo; a combo with any cannot be deleted. */
  bookingCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminCombo = z.infer<typeof adminComboSchema>;

/** Machine-readable `code` values of combo API errors. */
export const ComboErrorCode = {
  COMBO_NOT_FOUND: 'COMBO_NOT_FOUND',
  /** 409: same name ignoring case and diacritics. */
  COMBO_NAME_TAKEN: 'COMBO_NAME_TAKEN',
  /** 409: referenced by bookings; switch it off (`isActive: false`) instead. */
  COMBO_IN_USE: 'COMBO_IN_USE',
} as const;
export type ComboErrorCode = (typeof ComboErrorCode)[keyof typeof ComboErrorCode];
