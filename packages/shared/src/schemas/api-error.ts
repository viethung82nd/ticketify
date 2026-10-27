import { z } from 'zod';

/** Body of every error response returned by the API. */
export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  /** Machine-readable code, e.g. `VALIDATION_FAILED`, `NOT_FOUND`, `SEAT_UNAVAILABLE`. */
  code: z.string(),
  /** Human-readable summary. */
  message: z.string(),
  /** Optional structured details (validation errors, conflicting ids...). */
  details: z.unknown().optional(),
  path: z.string(),
  /** ISO-8601 instant. */
  timestamp: z.string(),
  requestId: z.string().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** Shape of `details` for `VALIDATION_FAILED` errors. */
export const fieldErrorSchema = z.object({
  field: z.string(),
  messages: z.array(z.string()),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
