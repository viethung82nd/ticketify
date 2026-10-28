import { normalizeEmail } from '@ticketify/shared';

/** `@Transform` callbacks that leave non-string input to the validators. */
export const trimValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const normalizeEmailValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeEmail(value) : value;
