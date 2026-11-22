import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * MoMo signatures (payment gateway API v2, documentation v3 at developers.momo.vn: "One-Time
 * Payments", "Payment Notification", "Check Transaction Status"; checked 22/11/2026 against MoMo's
 * official samples at github.com/momo-wallet/payment: `php/PayMoMo/init_payment.php`,
 * `php/PayMoMo/ipn_momo.php`, `php/atm/query_transaction.php`, `nodejs/MoMo.js`).
 *
 * HMAC-SHA256 keyed with the merchant secret key, lower-case hex, over `key=value` pairs joined by
 * `&`, for a FIXED list of fields per message (below). The lists are in a–z order because the
 * documentation sorts them that way, but they are fixed lists, not "every field, sorted": a field
 * MoMo adds to a message later is not signed until the documentation says it is, and a field
 * that is not in the list (`signature`, `lang`, `partnerUserId`, …) never is.
 *
 * Values go in exactly as they are: no URL encoding, no trimming (unlike VNPay, never reuse
 * `VnpayService` here). A JSON number is written in its decimal form (`String(n)`), which is how
 * the samples concatenate it. `accessKey` is never sent by MoMo in a result; it always comes from
 * our own configuration.
 *
 * Never log a secret key, an access key, a signature or a whole signed payload.
 */
export const MOMO_SIGNED_FIELDS = {
  /** `POST /v2/gateway/api/create` request. */
  create: [
    'accessKey',
    'amount',
    'extraData',
    'ipnUrl',
    'orderId',
    'orderInfo',
    'partnerCode',
    'redirectUrl',
    'requestId',
    'requestType',
  ],
  /** The IPN body and the redirect (`redirectUrl`) query: the same fields, the same signature. */
  result: [
    'accessKey',
    'amount',
    'extraData',
    'message',
    'orderId',
    'orderInfo',
    'orderType',
    'partnerCode',
    'payType',
    'requestId',
    'responseTime',
    'resultCode',
    'transId',
  ],
  /** `POST /v2/gateway/api/query` request. */
  query: ['accessKey', 'orderId', 'partnerCode', 'requestId'],
} as const;

export type MomoSignedMessage = keyof typeof MOMO_SIGNED_FIELDS;
type SignedField<M extends MomoSignedMessage> = (typeof MOMO_SIGNED_FIELDS)[M][number];

/** The values of one message's signed fields; `accessKey` comes from the credentials. */
export type MomoSignable<M extends MomoSignedMessage> = Record<
  Exclude<SignedField<M>, 'accessKey'>,
  string | number
>;

export interface MomoCredentials {
  accessKey: string;
  secretKey: string;
}

/** Lower-case hex HMAC-SHA256: 32 bytes → 64 characters. */
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * A field as it is signed: a string as it is, a safe integer in decimal. Anything else (missing,
 * `null`, an object, a fraction, a number past 2^53 that JSON already rounded) cannot be signed
 * faithfully and makes the message unverifiable.
 */
function signedValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/**
 * The exact text a signature of `message` covers, or `null` when one of its fields is missing or
 * of a type that cannot be signed.
 */
export function momoRawSignature(
  message: MomoSignedMessage,
  values: Readonly<Record<string, unknown>>,
  accessKey: string,
): string | null {
  const pairs: string[] = [];
  for (const field of MOMO_SIGNED_FIELDS[message]) {
    const value = field === 'accessKey' ? accessKey : signedValue(values[field]);
    if (value === null) return null;
    pairs.push(`${field}=${value}`);
  }
  return pairs.join('&');
}

/** HMAC-SHA256 of `raw` with the secret key, lower-case hex like the documentation. */
export function momoHmac(raw: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(raw, 'utf8').digest('hex');
}

/**
 * The `signature` of a request we send. Throws when a field is missing: that is a bug in our own
 * payload, never something to send.
 */
export function generateMomoSignature<M extends MomoSignedMessage>(
  message: M,
  values: MomoSignable<M>,
  credentials: MomoCredentials,
): string {
  const raw = momoRawSignature(message, values, credentials.accessKey);
  if (raw === null) throw new Error(`MoMo ${message} request is missing a signed field`);
  return momoHmac(raw, credentials.secretKey);
}

/**
 * `true` when `payload` (an IPN body, a redirect query or a query response) carries a valid
 * `signature` for `message`. Never throws: a missing or malformed signature, or a missing signed
 * field, is simply invalid. The signature must look like 64 hex characters before anything is
 * computed, and is compared in constant time; hex case does not matter.
 */
export function verifyMomoSignature(
  message: MomoSignedMessage,
  payload: Readonly<Record<string, unknown>>,
  credentials: MomoCredentials,
): boolean {
  const received = payload.signature;
  if (typeof received !== 'string' || !SIGNATURE_PATTERN.test(received)) return false;
  const raw = momoRawSignature(message, payload, credentials.accessKey);
  if (raw === null) return false;
  const expected = Buffer.from(momoHmac(raw, credentials.secretKey), 'utf8');
  const actual = Buffer.from(received.toLowerCase(), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
