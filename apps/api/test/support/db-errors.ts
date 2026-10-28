import {
  type ConstraintViolation,
  constraintViolationOf,
} from '../../src/infra/prisma/prisma-errors';

export {
  type ConstraintViolation,
  constraintViolationOf,
  SQLSTATE,
} from '../../src/infra/prisma/prisma-errors';

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
