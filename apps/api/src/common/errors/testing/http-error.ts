import { HttpException } from '@nestjs/common';

export interface HttpErrorShape {
  status: number;
  code: unknown;
  details?: unknown;
}

const shapeOf = (error: unknown): HttpErrorShape => {
  if (!(error instanceof HttpException)) throw error;
  const body = error.getResponse();
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return { status: error.getStatus(), code: record.code, details: record.details };
};

/** Runs `fn` and returns status/code of the `HttpException` it throws (fails if it does not). */
export function httpErrorOf(fn: () => unknown): HttpErrorShape {
  try {
    fn();
  } catch (error) {
    return shapeOf(error);
  }
  throw new Error('Expected an HttpException, but nothing was thrown');
}

/** Async variant of `httpErrorOf`. */
export async function asyncHttpErrorOf(work: Promise<unknown>): Promise<HttpErrorShape> {
  try {
    await work;
  } catch (error) {
    return shapeOf(error);
  }
  throw new Error('Expected an HttpException, but the promise resolved');
}
