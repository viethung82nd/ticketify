import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from './health-api';

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: fetchHealth, staleTime: 5_000 });
}
