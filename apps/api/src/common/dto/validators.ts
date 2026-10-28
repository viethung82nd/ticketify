import { isIsoDate } from '@ticketify/shared';
import { ValidateBy, ValidateIf } from 'class-validator';

/**
 * For PATCH bodies: skips validation when the property is absent, but unlike `@IsOptional()`
 * still validates `null`, so `{ "title": null }` is rejected instead of reaching the database.
 */
export const OptionalNotNull = (): PropertyDecorator =>
  ValidateIf((_object, value) => value !== undefined);

/** A calendar date `YYYY-MM-DD` (no time, no zone) that exists. */
export const IsIsoDate = (): PropertyDecorator =>
  ValidateBy({
    name: 'isIsoDate',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isIsoDate(value),
      defaultMessage: (args) => `${args?.property ?? 'value'} must be a date in YYYY-MM-DD format`,
    },
  });
