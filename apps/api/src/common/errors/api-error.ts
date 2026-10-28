import {
  BadRequestException,
  HttpException,
  HttpStatus,
  type ValidationError,
} from '@nestjs/common';
import type { ApiError, FieldError } from '@ticketify/shared';

/** Body of every error response returned by the API (schema lives in @ticketify/shared). */
export type ApiErrorBody = ApiError;

const DEFAULT_CODES: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

export function defaultErrorCode(status: number): string {
  return DEFAULT_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
}

/** Flattens class-validator errors (including nested objects) into `field -> messages`. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own: FieldError[] = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/** An `HttpException` whose body carries a machine-readable `code` (see AllExceptionsFilter). */
export function apiException(
  status: HttpStatus,
  code: string,
  message: string,
  details?: unknown,
): HttpException {
  return new HttpException({ code, message, details }, status);
}

/** `exceptionFactory` for the global ValidationPipe. */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed',
    details: flattenValidationErrors(errors),
  });
}
