import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * SePay webhook authentication, "HMAC-SHA256" mode (developer.sepay.vn/vi/sepay-webhooks/xac-thuc
 * and the Node.js sample, read 23/11/2026):
 * - `X-SePay-Signature: sha256={hex}` and `X-SePay-Timestamp: {Unix seconds}`;
 * - `{hex}` = HMAC-SHA256 of `{timestamp}.{raw body}` with the webhook's Secret Key, hex digest;
 * - the raw body as received, never re-serialized JSON;
 * - a timestamp more than 300 s from now is refused (replay).
 * The documentation gives no test vector, so the unit tests pin this reading of it; the first real
 * Test-mode delivery is what confirms it (docs/SEPAY_SETUP.md).
 */
export const SEPAY_HEADERS = {
  signature: 'x-sepay-signature',
  timestamp: 'x-sepay-timestamp',
} as const;

/** Largest accepted distance between `X-SePay-Timestamp` and our clock (documentation: 5 min). */
export const SEPAY_TIMESTAMP_TOLERANCE_SECONDS = 300;

const SIGNATURE_PREFIX = 'sha256=';
const TIMESTAMP = /^\d{1,12}$/;

/** `sha256={hex}` for this timestamp and raw body: what SePay sends in `X-SePay-Signature`. */
export function signSepayWebhook(secret: string, timestamp: string, rawBody: Buffer): string {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `${SIGNATURE_PREFIX}${hmac}`;
}

export interface SepaySignatureInput {
  secret: string;
  /** Header values as Node gives them (a repeated header is an array: never valid). */
  signature: string | string[] | undefined;
  timestamp: string | string[] | undefined;
  rawBody: Buffer | undefined;
  now: Date;
}

/** Why a delivery was not authenticated; for the log only, never for the response body. */
export type SepaySignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks one delivery's signature and timestamp. Constant-time comparison; the expected value is
 * never returned or logged.
 */
export function verifySepaySignature(input: SepaySignatureInput): SepaySignatureCheck {
  const { signature, timestamp, rawBody } = input;
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'missing or malformed X-SePay-Signature' };
  }
  if (typeof timestamp !== 'string' || !TIMESTAMP.test(timestamp)) {
    return { ok: false, reason: 'missing or malformed X-SePay-Timestamp' };
  }
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - Number(timestamp));
  if (skew > SEPAY_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp ${skew} s away from now (replay window 300 s)` };
  }
  if (!rawBody || rawBody.length === 0) return { ok: false, reason: 'no raw body to verify' };

  const expected = Buffer.from(signSepayWebhook(input.secret, timestamp, rawBody), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'invalid signature' };
  }
  return { ok: true };
}

/** Upper bound of every integer SePay sends: exact in a JavaScript number. */
const safeInteger = z.number().int().max(Number.MAX_SAFE_INTEGER);
const optionalText = (max: number) => z.string().max(max).nullish();

/**
 * One bank transaction as SePay's webhook sends it (developer.sepay.vn/vi/sepay-webhooks/
 * tich-hop-webhook, JSON content type). Fields we do not act on are optional (the Test-mode sample
 * has no `description`), unknown extra fields are kept, and a value of the wrong type refuses the
 * whole body. `transferType` other than `in` / `out` is not a transaction we understand.
 */
export const sepayWebhookSchema = z.looseObject({
  /** SePay's transaction id: the same on every retry and replay (the dedupe key). */
  id: safeInteger.positive(),
  gateway: optionalText(100),
  /** "YYYY-MM-DD HH:mm:ss", Vietnam time. Kept as sent. */
  transactionDate: optionalText(40),
  accountNumber: z.string().min(1).max(64),
  /** The VA that matched, `""` or null when none. */
  subAccount: optionalText(64),
  /** The payment code SePay extracted from `content`; null when no configured pattern matched. */
  code: optionalText(100),
  content: optionalText(1000),
  transferType: z.enum(['in', 'out']),
  /** VND, whole dong, always positive in the documentation. */
  transferAmount: safeInteger.nonnegative(),
  accumulated: z.number().nullish(),
  referenceCode: optionalText(100),
  description: optionalText(1000),
});
export type SepayWebhook = z.infer<typeof sepayWebhookSchema>;

/** The parsed body, or the first problem found (field path and message, never a value). */
export function parseSepayWebhook(
  body: unknown,
): { ok: true; webhook: SepayWebhook } | { ok: false; reason: string } {
  const result = sepayWebhookSchema.safeParse(body);
  if (result.success) return { ok: true, webhook: result.data };
  const issue = result.error.issues[0];
  const where = issue?.path.length ? issue.path.join('.') : 'body';
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid'}` };
}
