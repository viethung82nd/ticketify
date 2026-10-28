/**
 * Calendar dates (`YYYY-MM-DD`, no time, no zone) and Postgres `date` columns.
 *
 * Prisma reads and writes `@db.Date` as a `Date` at UTC midnight, so these two conversions are
 * exact. Compare dates as `YYYY-MM-DD` strings (or `::date` in SQL), never as instants.
 */

/** `date` columns come back as UTC midnight; the calendar date is the ISO prefix. */
export const formatIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** `YYYY-MM-DD` (already validated) → the `Date` Prisma writes to a `date` column. */
export const parseIsoDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
