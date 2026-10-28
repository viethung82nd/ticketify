import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { getRoom, listRooms } from './rooms-api';

export const roomKeys = {
  all: ['rooms'] as const,
  list: ['rooms', 'list'] as const,
  detail: (id: string) => ['rooms', 'detail', id] as const,
};

const retryUnlessClientError = (failureCount: number, error: unknown): boolean => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return failureCount < 1 && !(status !== undefined && status >= 400 && status < 500);
};

export const useRooms = () => useQuery({ queryKey: roomKeys.list, queryFn: listRooms });

/**
 * The seat editor diffs its draft against this snapshot, so it must not change behind the
 * user's back: no refetch on focus, refreshed only after a save or an explicit reload.
 */
export const useRoom = (id: string) =>
  useQuery({
    queryKey: roomKeys.detail(id),
    queryFn: () => getRoom(id),
    retry: retryUnlessClientError,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
