import { isIsoDate, isIsoInstant } from '@ticketify/shared';
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

/** An ISO 8601 date-time with an explicit offset (`Z` or `±HH:mm`), e.g. `2026-11-02T19:30:00+07:00`. */
export const IsIsoInstant = (): PropertyDecorator =>
  ValidateBy({
    name: 'isIsoInstant',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isIsoInstant(value),
      defaultMessage: (args) =>
        `${args?.property ?? 'value'} must be an ISO 8601 date-time with a UTC offset`,
    },
  });
