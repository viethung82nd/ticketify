import { createHash, randomBytes } from 'node:crypto';

const REFRESH_TOKEN_BYTES = 32;

/** SHA-256 (hex) of a raw refresh token — the only form stored in `refresh_tokens.token_hash`. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A new opaque refresh token: 32 random bytes, base64url (43 chars), plus its hash.
 * The raw value only ever goes to the client cookie.
 */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}
