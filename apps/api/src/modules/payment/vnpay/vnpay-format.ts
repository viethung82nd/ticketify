import { randomInt } from 'node:crypto';
import { isIPv4 } from 'node:net';

/** VNPay dates are wall-clock GMT+7 (no daylight saving), whatever the server's time zone. */
const GMT7_OFFSET_MS = 7 * 60 * 60 * 1_000;

/** `vnp_CreateDate` / `vnp_ExpireDate`: `yyyyMMddHHmmss` in GMT+7, truncated to the second. */
export function vnpayDate(instant: Date): string {
  const iso = new Date(instant.getTime() + GMT7_OFFSET_MS).toISOString();
  // 2026-11-01T17:00:00.000Z → 20261101170000
  return iso.slice(0, 19).replace(/[-T:]/g, '');
}

const TXN_REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const TXN_REF_LENGTH = 20;

/**
 * `vnp_TxnRef`: 20 random letters and digits (62^20 ≈ 7·10^35 values) from the CSPRNG. Unique
 * across all payments by `payments_txn_ref_key`, which is stricter than VNPay's "unique per day".
 */
export function newTxnRef(): string {
  let ref = '';
  for (let i = 0; i < TXN_REF_LENGTH; i++)
    ref += TXN_REF_ALPHABET[randomInt(TXN_REF_ALPHABET.length)];
  return ref;
}

const MAPPED_IPV4_PREFIX = '::ffff:';

/**
 * `vnp_IpAddr` from `req.ip` (which follows `TRUST_PROXY`). An IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.5`, what a dual-stack socket reports) becomes its IPv4 form and the IPv6
 * loopback `127.0.0.1`; any other IPv6 address is sent as it is (VNPay accepts up to 45
 * characters). No address at all (the socket is already gone) is the unspecified `0.0.0.0`.
 */
export function vnpayIpAddr(ip: string | undefined): string {
  if (!ip) return '0.0.0.0';
  const lower = ip.toLowerCase();
  if (lower.startsWith(MAPPED_IPV4_PREFIX) && isIPv4(lower.slice(MAPPED_IPV4_PREFIX.length))) {
    return lower.slice(MAPPED_IPV4_PREFIX.length);
  }
  if (lower === '::1') return '127.0.0.1';
  return ip;
}
