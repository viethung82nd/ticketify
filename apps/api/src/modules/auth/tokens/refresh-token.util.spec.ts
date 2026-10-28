import { createHash } from 'node:crypto';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.util';

describe('refresh token util', () => {
  it('generates 32 random bytes encoded as base64url (43 chars, no padding)', () => {
    const { token } = generateRefreshToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => generateRefreshToken().token));

    expect(tokens.size).toBe(1_000);
  });

  it('returns the SHA-256 hex digest as the stored hash, not the token', () => {
    const { token, tokenHash } = generateRefreshToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHash).not.toContain(token);
  });

  it('hashes deterministically', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });
});
