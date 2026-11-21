import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';

/** The error axios throws for an API error answer: what `apiErrorOf()` reads in the app. */
export function apiError(statusCode: number, code: string, details?: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response: AxiosResponse = {
    status: statusCode,
    statusText: '',
    headers: {},
    config,
    data: {
      statusCode,
      code,
      message: code,
      ...(details === undefined ? {} : { details }),
      path: '/test',
      timestamp: '2026-11-22T00:00:00.000Z',
    },
  };
  return new AxiosError(code, String(statusCode), config, undefined, response);
}

/** A request that never got an answer (offline, CORS, timeout). */
export const networkError = (): AxiosError => new AxiosError('Network Error', 'ERR_NETWORK');
