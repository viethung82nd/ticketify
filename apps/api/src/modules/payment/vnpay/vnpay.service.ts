import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** Parameter values as merchants build them; `undefined` and `''` are left out of the request. */
export type VnpayParams = Readonly<Record<string, string | number | undefined>>;

/** A query string parsed by Express: a repeated key comes as an array, which is never valid. */
export type VnpayQuery = Readonly<Record<string, unknown>>;

/** The parameters that carry the signature and are never part of the signed data. */
const SIGNATURE_PARAMS = new Set(['vnp_SecureHash', 'vnp_SecureHashType']);

/** HMAC-SHA512 in hex: 64 bytes → 128 characters. */
const HASH_HEX_LENGTH = 128;

/**
 * Encodes a key or value the way the VNPay documentation does (its PHP sample uses `urlencode`,
 * its Java sample `URLEncoder.encode`): UTF-8 percent-encoding with upper-case hex, a space as `+`,
 * and only `A–Z a–z 0–9 - _ .` left as they are.
 *
 * `encodeURIComponent` alone differs on two points: a space becomes `%20` instead of `+`, and it
 * leaves `! ' ( ) * ~` unencoded. Both are corrected here, so `Thanh toan don hang :5` gives the
 * documentation's `Thanh+toan+don+hang+%3A5`.
 */
export function encodeVnpay(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/**
 * `key=value&…` of the non-empty parameters, keys in ascending ASCII order, both encoded with
 * `encodeVnpay`. The same string is the signed data and the query sent to VNPay.
 */
export function canonicalQuery(params: VnpayParams): string {
  return Object.entries(params)
    .flatMap(([key, value]) =>
      value === undefined || value === '' ? [] : [[key, String(value)] as const],
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeVnpay(key)}=${encodeVnpay(value)}`)
    .join('&');
}

/** HMAC-SHA512 of `data` with the merchant's hash secret, lower-case hex like the documentation. */
export function vnpaySignature(data: string, hashSecret: string): string {
  return createHmac('sha512', hashSecret).update(data, 'utf8').digest('hex');
}

/**
 * Signing and checking VNPay requests (ROADMAP 3.1). Pure: no database, no configuration of its
 * own; the hash secret is passed in by the caller (it comes from `VNPAY_HASH_SECRET`).
 *
 * Never log the hash secret, and never log a signed query as a whole: it may carry customer data
 * (the order description, the client IP).
 */
@Injectable()
export class VnpayService {
  /**
   * The query string of a payment URL: the canonical query of `params` followed by
   * `&vnp_SecureHash=<HMAC-SHA512 of it>` (the documentation appends the hash last, unsorted).
   */
  buildSignedQuery(params: VnpayParams, hashSecret: string): string {
    const data = canonicalQuery(withoutSignature(params));
    return `${data}&vnp_SecureHash=${vnpaySignature(data, hashSecret)}`;
  }

  /**
   * `true` when `query` (the parameters VNPay sent back to the return URL or the IPN, already
   * decoded) carries a valid `vnp_SecureHash`. Never throws: a missing, repeated or malformed hash,
   * or a repeated parameter, is simply invalid. The hash is compared in constant time; hex case
   * does not matter.
   */
  verifySignature(query: VnpayQuery, hashSecret: string): boolean {
    const received = query.vnp_SecureHash;
    if (typeof received !== 'string' || received.length !== HASH_HEX_LENGTH) return false;

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (SIGNATURE_PARAMS.has(key)) continue;
      if (typeof value !== 'string') return false;
      params[key] = value;
    }
    const expected = Buffer.from(vnpaySignature(canonicalQuery(params), hashSecret), 'utf8');
    const actual = Buffer.from(received.toLowerCase(), 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function withoutSignature(params: VnpayParams): VnpayParams {
  return Object.fromEntries(Object.entries(params).filter(([key]) => !SIGNATURE_PARAMS.has(key)));
}
