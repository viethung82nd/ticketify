import { MOMO_PENDING_RESULT_CODES } from '@ticketify/shared';
import type { Prisma } from '../../../generated/prisma/client';
import type { PaymentReport } from '../payment-report';

/**
 * Reading MoMo results: the IPN body, the redirect query and the query API response (payment
 * gateway API v2, documentation v3 "Payment Notification" and "List Result Codes", 22/11/2026).
 * Pure: no HTTP, no clock, no configuration.
 */

/** `resultCode` of a successful transaction ("Successful.", final). */
export const MOMO_RESULT_SUCCESS = 0;

/**
 * `resultCode`s MoMo documents as **not final**: the transaction can still change, so nothing is
 * recorded for them and the attempt stays PENDING.
 * - `1000`: initiated, waiting for the user to confirm;
 * - `7000`: being processed; `7002`: being processed by the provider of the payment instrument;
 * - `8000`: waiting for the user to confirm the payment again;
 * - `9000`: authorized but not captured. A one-time wallet payment is created with MoMo's default
 *   `autoCapture: true` and should never stop here; if it does, the money is not ours yet.
 */
export const MOMO_PENDING_CODES: ReadonlySet<number> = new Set(MOMO_PENDING_RESULT_CODES);

export const MomoResultState = {
  /** `resultCode` 0: the money was taken. */
  PAID: 'paid',
  /** Any other final code: the attempt is over and the user may pay again. */
  FAILED: 'failed',
  /** A code from `MOMO_PENDING_CODES`: wait for the final result. */
  PENDING: 'pending',
} as const;
export type MomoResultState = (typeof MomoResultState)[keyof typeof MomoResultState];

export function momoResultState(resultCode: number): MomoResultState {
  if (resultCode === MOMO_RESULT_SUCCESS) return MomoResultState.PAID;
  return MOMO_PENDING_CODES.has(resultCode) ? MomoResultState.PENDING : MomoResultState.FAILED;
}

/** The fields of a result (IPN or redirect) this application acts on, typed. */
export interface MomoResultFields {
  partnerCode: string;
  orderId: string;
  requestId: string;
  /** VND, whole dong. */
  amount: number;
  resultCode: number;
  /** MoMo's transaction id, in decimal. */
  transId: string;
  message: string;
  payType: string;
}

/** Long fields arrive as JSON numbers in the IPN and as decimal strings in the redirect query. */
function integerOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) return Number(value);
  return null;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * The typed fields of a result whose signature was already checked, or `null` when one of them is
 * missing or of the wrong type (an `orderId` that is not a string, an `amount` that is not a
 * whole number, …). `null` means "malformed": nothing is looked up or written for it.
 */
export function readMomoResultFields(
  payload: Readonly<Record<string, unknown>>,
): MomoResultFields | null {
  const { partnerCode, orderId, requestId, message, payType } = payload;
  const amount = integerOf(payload.amount);
  const resultCode = integerOf(payload.resultCode);
  const transId = integerOf(payload.transId);
  if (!nonEmpty(partnerCode) || !nonEmpty(orderId) || !nonEmpty(requestId)) return null;
  if (amount === null || resultCode === null || transId === null) return null;
  if (typeof message !== 'string' || typeof payType !== 'string') return null;
  return {
    partnerCode,
    orderId,
    requestId,
    amount,
    resultCode,
    transId: String(transId),
    message,
    payType,
  };
}

/**
 * The `PaymentReport` of a final MoMo result (paid or failed; a pending one is never recorded).
 * `transId` is kept only when it names a real transaction (> 0); it is stored only for a paid
 * attempt anyway, and the whole payload stays in `raw_payload`.
 */
export function readMomoReport(
  fields: MomoResultFields,
  raw: Readonly<Record<string, unknown>>,
): PaymentReport {
  return {
    amount: String(fields.amount),
    paid: momoResultState(fields.resultCode) === MomoResultState.PAID,
    responseCode: String(fields.resultCode),
    transactionStatus: null,
    bankCode: null,
    transactionNo:
      fields.transId !== '0' && !fields.transId.startsWith('-') ? fields.transId : null,
    raw: raw as Prisma.InputJsonObject,
  };
}
