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
