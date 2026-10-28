import { Prisma } from '../../generated/prisma/client';

/** Prisma error codes the services translate into API errors. */
export const PrismaErrorCode = {
  uniqueViolation: 'P2002',
  foreignKeyViolation: 'P2003',
  recordNotFound: 'P2025',
} as const;
type PrismaErrorCode = (typeof PrismaErrorCode)[keyof typeof PrismaErrorCode];

export function isPrismaError(error: unknown, code: PrismaErrorCode): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/** Postgres SQLSTATE codes for constraint violations. */
export const SQLSTATE = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  exclusionViolation: '23P01',
} as const;

export interface ConstraintViolation {
  sqlState: string;
  constraint: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * SQLSTATE and constraint name of a Prisma 7 driver-adapter error, for the rules Prisma has no
 * error code for (exclusion and CHECK constraints, prisma/README.md).
 * Shape: `error.meta.driverAdapterError.cause` = `{ originalCode, originalMessage, constraint? }`.
 *
 * `@prisma/adapter-pg` copies the constraint name into `constraint.index` only for unique and FK
 * violations; for the others the name is the quoted identifier Postgres puts in the message
 * (`... violates exclusion constraint "showtimes_no_overlap"`). Callers match on SQLSTATE and
 * that exact name, never on the wording around it.
 */
export function constraintViolationOf(error: unknown): ConstraintViolation | undefined {
  if (!isRecord(error) || !isRecord(error.meta)) return undefined;
  const adapterError = error.meta.driverAdapterError;
  if (!isRecord(adapterError) || !isRecord(adapterError.cause)) return undefined;
  const cause = adapterError.cause;

  const sqlState = typeof cause.originalCode === 'string' ? cause.originalCode : undefined;
  const fromIndex =
    isRecord(cause.constraint) && typeof cause.constraint.index === 'string'
      ? cause.constraint.index
      : undefined;
  const fromMessage =
    typeof cause.originalMessage === 'string'
      ? /constraint "([^"]+)"/.exec(cause.originalMessage)?.[1]
      : undefined;
  const constraint = fromIndex ?? fromMessage;

  return sqlState && constraint ? { sqlState, constraint } : undefined;
}

/** `true` when `error` is a violation of exactly this constraint. */
export function isConstraintViolation(error: unknown, expected: ConstraintViolation): boolean {
  const violation = constraintViolationOf(error);
  return violation?.sqlState === expected.sqlState && violation.constraint === expected.constraint;
}
