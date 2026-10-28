import type { ApiError } from '@ticketify/shared';
import type { Response } from 'supertest';

/** Typed view of a supertest body (`res.body` is `any`). */
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}

/** The standard API error body. */
export const errorOf = (res: Response): ApiError => bodyOf<ApiError>(res);

/** All `Set-Cookie` headers of a response. */
export function setCookiesOf(res: Response): string[] {
  const header: unknown = res.headers['set-cookie'];
  if (Array.isArray(header))
    return header.filter((item): item is string => typeof item === 'string');
  return typeof header === 'string' ? [header] : [];
}

/** The full `Set-Cookie` line for `name`, if the response sets it. */
export function setCookieLine(res: Response, name: string): string | undefined {
  return setCookiesOf(res).find((line) => line.startsWith(`${name}=`));
}

/** Value of cookie `name` set by the response (empty string when it is being cleared). */
export function cookieValue(res: Response, name: string): string | undefined {
  const line = setCookieLine(res, name);
  if (line === undefined) return undefined;
  return decodeURIComponent(line.slice(name.length + 1).split(';')[0] ?? '');
}
