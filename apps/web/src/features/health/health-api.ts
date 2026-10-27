import { healthResponseSchema } from '@ticketify/shared';
import { apiClient } from '@/lib/api-client';

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
