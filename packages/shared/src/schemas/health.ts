import { z } from 'zod';
import { apiErrorSchema } from './api-error.js';

export const healthIndicatorSchema = z.object({
  status: z.enum(['up', 'down']),
  message: z.string().optional(),
});

const healthDetailsSchema = z.record(z.string(), healthIndicatorSchema);

/** `GET /health` → 200: every dependency is up. */
export const healthOkSchema = z.object({
  status: z.literal('ok'),
  details: healthDetailsSchema,
});

/** `GET /health` → 503: standard API error whose `details` hold every indicator. */
export const healthDownSchema = apiErrorSchema.extend({
  statusCode: z.literal(503),
  details: healthDetailsSchema,
});

export const healthResponseSchema = z.union([healthOkSchema, healthDownSchema]);

export type HealthIndicator = z.infer<typeof healthIndicatorSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
