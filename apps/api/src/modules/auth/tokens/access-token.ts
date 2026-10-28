/** Only algorithm accepted for access tokens; pinning it blocks `alg: none` and key confusion. */
export const ACCESS_TOKEN_ALGORITHM = 'HS256';

/** Claims carried by an access token (besides the standard `iat` / `exp`). */
export interface AccessTokenClaims {
  sub: string;
  role: string;
}

export const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
