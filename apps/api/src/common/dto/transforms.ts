import { normalizeEmail } from '@ticketify/shared';

/** `@Transform` callbacks that leave non-string input to the validators. */
export const trimValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const normalizeEmailValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeEmail(value) : value;

/** Trims and normalizes to NFC, so "ầ" typed as base letter + combining marks is stored once. */
export const trimNfcValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().normalize('NFC') : value;

/** Trims; a blank string becomes `undefined` (an empty `?q=` means "no search"). */
export const blankToUndefined = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};
