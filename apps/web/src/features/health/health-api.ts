import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

const indicatorSchema = z.object({
  status: z.enum(['up', 'down']),
  message: z.string().optional(),
});

/** 200 → terminus result; 503 → standard API error body whose details hold the indicators. */
const healthResponseSchema = z.union([
  z.object({ status: z.literal('ok'), details: z.record(z.string(), indicatorSchema) }),
  z.object({ statusCode: z.literal(503), details: z.record(z.string(), indicatorSchema) }),
]);

export interface ServiceHealth {
  name: string;
  up: boolean;
  message?: string;
}

export interface HealthReport {
  healthy: boolean;
  services: ServiceHealth[];
}

export async function fetchHealth(): Promise<HealthReport> {
  const response = await apiClient.get<unknown>('/health', {
    // 503 is a valid answer ("something is down"), not a transport failure.
    validateStatus: (status) => status === 200 || status === 503,
  });
  const body = healthResponseSchema.parse(response.data);
  return {
    healthy: response.status === 200,
    services: Object.entries(body.details).map(([name, indicator]) => ({
      name,
      up: indicator.status === 'up',
      message: indicator.message,
    })),
  };
}
