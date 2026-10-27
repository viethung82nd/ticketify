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
 * Extracts the Postgres SQLSTATE and constraint name from a Prisma 7 driver-adapter error.
 * Shape: `error.meta.driverAdapterError.cause` = `{ originalCode, originalMessage, constraint? }`.
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

/** Awaits `work` and asserts it failed with exactly this constraint violation. */
export async function expectViolation(
  work: Promise<unknown>,
  expected: ConstraintViolation,
): Promise<void> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error === undefined) {
    throw new Error(`Expected ${expected.constraint} to reject the write, but it succeeded`);
  }
  expect(constraintViolationOf(error)).toEqual(expected);
}
