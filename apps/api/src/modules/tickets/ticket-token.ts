import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The token a ticket's QR code carries (PLAN §7, ROADMAP 4.7): the ticket code and an HMAC of it,
 * `{code}.{signature}`.
 *
 * Why sign at all, when `tickets.code` is already unique and random: the signature means a staff
 * device can reject a made-up code before any database round-trip, and that nobody can print a
 * ticket for a code they guessed. It is NOT a session or a capability — check-in still looks the
 * code up and only moves a ticket that is `ISSUED` (`UPDATE … WHERE code = $1 AND status =
 * 'ISSUED'`), so a replayed token is caught there, not here.
 *
 * The signature is truncated to 20 bytes (160 bits) so the QR stays small enough to scan from a
 * phone screen; forging one still means finding a preimage of a keyed hash.
 */

const SEPARATOR = '.';
const SIGNATURE_BYTES = 20;

/** base64url of the first 20 bytes of HMAC-SHA256(secret, code): 27 characters. */
export function signTicketCode(code: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(code)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url');
}

/** The whole token: what goes into the QR image. */
export const ticketToken = (code: string, secret: string): string =>
  `${code}${SEPARATOR}${signTicketCode(code, secret)}`;

/**
 * The ticket code of a token whose signature checks out, or `null` for anything else (wrong
 * shape, wrong signature, a code from another environment's secret). Compared in constant time.
 */
export function readTicketToken(token: string, secret: string): string | null {
  const separator = token.lastIndexOf(SEPARATOR);
  if (separator <= 0 || separator === token.length - 1) return null;
  const code = token.slice(0, separator);
  const given = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = Buffer.from(signTicketCode(code, secret), 'base64url');
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? code : null;
}
