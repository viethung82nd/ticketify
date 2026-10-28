import { inspect } from 'node:util';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

/** What the API turned into a 5xx, with the raw error behind it. */
export interface ServerError {
  statusCode: number;
  code: string;
  path: string;
  /** Constructor name of the thrown value (e.g. `PrismaClientKnownRequestError`). */
  error: string;
  /** Prisma error code (`P2028`, `P2034`, …), when there is one. */
  prismaCode?: string;
  /** Postgres SQLSTATE behind a driver-adapter error, when there is one. */
  sqlState?: string;
  message: string;
  stack?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function describeError(exception: unknown): Omit<ServerError, 'statusCode' | 'code' | 'path'> {
  if (!isRecord(exception)) return { error: typeof exception, message: String(exception) };
  const meta = isRecord(exception.meta) ? exception.meta : undefined;
  const adapter = meta && isRecord(meta.driverAdapterError) ? meta.driverAdapterError : undefined;
  const cause = adapter && isRecord(adapter.cause) ? adapter.cause : undefined;
  return {
    error: exception.constructor.name,
    prismaCode: typeof exception.code === 'string' ? exception.code : undefined,
    sqlState: typeof cause?.originalCode === 'string' ? cause.originalCode : undefined,
    message: typeof exception.message === 'string' ? exception.message : inspect(exception),
    stack: typeof exception.stack === 'string' ? exception.stack : undefined,
  };
}

/**
 * Records every exception `AllExceptionsFilter` turns into a 5xx, with the Prisma code,
 * SQLSTATE and stack the response body hides. Suites boot the app with `logger: false`, so
 * without this a 500 in a concurrency test says nothing about its cause.
 */
export function captureServerErrors(): {
  errors: ServerError[];
  clear(): void;
  restore(): void;
} {
  const errors: ServerError[] = [];
  // Read off the prototype as a plain function, so it can be called with the filter as `this`.
  const original = Reflect.get<AllExceptionsFilter, 'toBody'>(
    AllExceptionsFilter.prototype,
    'toBody',
  );
  const spy = jest.spyOn(AllExceptionsFilter.prototype, 'toBody').mockImplementation(function (
    this: AllExceptionsFilter,
    exception,
    request,
  ) {
    const body = original.call(this, exception, request);
    if (body.statusCode >= 500) {
      errors.push({
        statusCode: body.statusCode,
        code: body.code,
        path: body.path,
        ...describeError(exception),
      });
    }
    return body;
  });
  return {
    errors,
    clear: () => errors.splice(0),
    restore: () => spy.mockRestore(),
  };
}

/** One line per error plus its stack, for an assertion message. */
export function formatServerErrors(errors: ServerError[]): string {
  return errors
    .map(
      (e, i) =>
        `#${i + 1} ${e.statusCode} ${e.code} ${e.path} ${e.error}` +
        ` prisma=${e.prismaCode ?? '-'} sqlstate=${e.sqlState ?? '-'}\n${e.stack ?? e.message}`,
    )
    .join('\n\n');
}
