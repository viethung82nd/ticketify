import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { BOOKING_LIMITS, isIdempotencyKey } from '@ticketify/shared';
import type { Request } from 'express';
import { validationFailed } from '../../common/errors/api-error';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

const invalidKey = (message: string) =>
  validationFailed([{ field: IDEMPOTENCY_KEY_HEADER, messages: [message] }]);

/**
 * The required `Idempotency-Key` header. Missing, repeated or malformed → `400 VALIDATION_FAILED`
 * with `details[].field = 'Idempotency-Key'`.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const value = ctx.switchToHttp().getRequest<Request>().headers['idempotency-key'];
  if (value === undefined || value === '') {
    throw invalidKey(`${IDEMPOTENCY_KEY_HEADER} header is required`);
  }
  if (typeof value !== 'string' || !isIdempotencyKey(value)) {
    throw invalidKey(
      `${IDEMPOTENCY_KEY_HEADER} must be ${BOOKING_LIMITS.idempotencyKeyMin}–` +
        `${BOOKING_LIMITS.idempotencyKeyMax} characters from A–Z a–z 0–9 . _ ~ : -`,
    );
  }
  return value;
});
