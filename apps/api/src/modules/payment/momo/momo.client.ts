import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config.service';
import { momoEndpointOf } from '../../../config/env.schema';
import type { PaymentReport } from '../payment-report';
import { MOMO_RESULT_SUCCESS, MomoResultState, momoResultState } from './momo-result';
import { generateMomoSignature, type MomoCredentials } from './momo-signature';

/**
 * MoMo payment gateway API v2 (documentation v3, developers.momo.vn, 22/11/2026):
 * - `POST {MOMO_ENDPOINT}/v2/gateway/api/create`, one-time wallet payment (`captureWallet`);
 * - `POST {MOMO_ENDPOINT}/v2/gateway/api/query`, transaction status.
 * Both are JSON over HTTPS and both ask the caller for a timeout of at least 30 s.
 */
export const MOMO_PATHS = {
  create: '/v2/gateway/api/create',
  query: '/v2/gateway/api/query',
} as const;

/** Values fixed by the API for this integration, not by configuration. */
export const MOMO_REQUEST = {
  /** One-time payment from the MoMo wallet (QR or app); MoMo's default `autoCapture: true`. */
  requestType: 'captureWallet',
  /** Language of MoMo's messages and payment page. */
  lang: 'vi',
  /** No extra data: the documentation's default is the empty string (it is still signed). */
  extraData: '',
} as const;

/** `amount` limits of a wallet payment, VND (documentation: "Min: 1.000 VND, Max: 50.000.000 VND"). */
export const MOMO_AMOUNT_LIMITS = { min: 1_000, max: 50_000_000 } as const;

/** Merchant settings a signed MoMo message needs. */
export interface MomoMerchant extends MomoCredentials {
  partnerCode: string;
}

/** Everything a create call needs on top of the merchant. */
export interface MomoCreateSettings extends MomoMerchant {
  redirectUrl: string;
  ipnUrl: string;
}

export interface MomoCreateInput {
  /** `orderId`: our payment's `txn_ref`. */
  orderId: string;
  /** `requestId`: our payment's `provider_request_id`; the same on every re-send. */
  requestId: string;
  /** VND, whole dong. */
  amount: number;
  /** Shown to the customer by MoMo. */
  orderInfo: string;
}

/** What one create call gave. Only `created` carries a payment page. */
export type MomoCreateAnswer =
  /** `resultCode` 0 and a usable `payUrl` for exactly this order. */
  | { kind: 'created'; payUrl: string; resultCode: number }
  /**
   * MoMo answered with a final error (`resultCode` not 0 and not in progress): it did not create
   * a payable order for this request. `body` has the signature removed.
   */
  | { kind: 'refused'; resultCode: number; message: string; body: Record<string, unknown> }
  /**
   * No usable answer: timeout, network error, HTTP error without a MoMo body, a request still in
   * progress at MoMo (`7000`, or another not-final code), or a "success" that does not match the
   * request. MoMo may have accepted the request, so the caller keeps the attempt and re-sends it
   * unchanged later (MoMo answers a repeated `requestId` idempotently).
   */
  | { kind: 'unavailable'; reason: string; timedOut: boolean };

/** What one query lets the booking expiry conclude about the money. */
export const MomoQueryVerdict = {
  /** MoMo reports the order paid (`resultCode` 0) and the answer is about exactly this order. */
  PAID: 'paid',
  /** MoMo reports a final failure: no money is coming for this order. */
  NOT_PAID: 'not_paid',
  /** No answer to act on: network, timeout, malformed, not final yet. Treated like NOT_PAID. */
  UNKNOWN: 'unknown',
} as const;
export type MomoQueryVerdict = (typeof MomoQueryVerdict)[keyof typeof MomoQueryVerdict];

export interface MomoQueryAnswer {
  verdict: MomoQueryVerdict;
  /** Present when `verdict` is PAID: what `settlePayment` records. */
  report: PaymentReport | null;
  resultCode: number | null;
  /** One line for the log; never a signature or a key. */
  reason: string;
}

/** `requestId` of a new message: the 32 hex characters of a UUIDv4 (MoMo allows up to 50). */
export const newMomoRequestId = (): string => randomUUID().replace(/-/g, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const integerOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/**
 * The `name` of a thrown value. `AbortSignal.timeout` rejects with a `DOMException` named
 * `TimeoutError`, which is not always `instanceof Error` (another realm), so only the name counts.
 */
const errorName = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';

/** A request that got no answer: timed out (MoMo may still have it) or never reached MoMo. */
function failure(error: unknown, timeoutMs: number) {
  const timedOut = errorName(error) === 'TimeoutError';
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : String(error);
  return {
    kind: 'failed' as const,
    reason: timedOut ? `timed out after ${timeoutMs} ms` : `network error: ${message}`,
    timedOut,
  };
}

/** A MoMo body without its `signature`: what may be stored or logged as metadata. */
export const withoutSignature = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'signature'));

/**
 * Talks to MoMo's payment gateway. Never throws on the network: a timeout, an HTTP error or a
 * malformed body becomes an answer the caller decides on. Logs the order id, the stage and the
 * result code only; never a key, a signature or a whole payload.
 */
@Injectable()
export class MomoClient {
  private readonly logger = new Logger(MomoClient.name);

  constructor(private readonly config: AppConfig) {}

  /** Partner code, access key and secret key, or `null` when one is unset. Read per call. */
  merchant(): MomoMerchant | null {
    const partnerCode = this.config.get('MOMO_PARTNER_CODE');
    const accessKey = this.config.get('MOMO_ACCESS_KEY');
    const secretKey = this.config.get('MOMO_SECRET_KEY');
    if (!partnerCode || !accessKey || !secretKey) return null;
    return { partnerCode, accessKey, secretKey };
  }

  /**
   * The gateway to call (`momoEndpointOf`): `MOMO_ENDPOINT`, or the sandbox outside production;
   * `null` in production without one, which makes MoMo unavailable rather than the sandbox.
   */
  endpoint(): string | null {
    return momoEndpointOf({
      NODE_ENV: this.config.get('NODE_ENV'),
      MOMO_ENDPOINT: this.config.get('MOMO_ENDPOINT'),
    });
  }

  /** The merchant plus the redirect and IPN URLs, or `null` when anything (or the endpoint) is unset. */
  createSettings(): MomoCreateSettings | null {
    const merchant = this.merchant();
    const redirectUrl = this.config.get('MOMO_REDIRECT_URL');
    const ipnUrl = this.config.get('MOMO_IPN_URL');
    if (!merchant || !redirectUrl || !ipnUrl || this.endpoint() === null) return null;
    return { ...merchant, redirectUrl, ipnUrl };
  }

  /** `false` when the merchant keys or the endpoint are missing: MoMo cannot be asked anything. */
  get configured(): boolean {
    return this.merchant() !== null && this.endpoint() !== null;
  }

  /** The signed create body, exactly as it is sent (exported for tests through `createBody`). */
  createBody(settings: MomoCreateSettings, input: MomoCreateInput): Record<string, unknown> {
    const signed = {
      amount: input.amount,
      extraData: MOMO_REQUEST.extraData,
      ipnUrl: settings.ipnUrl,
      orderId: input.orderId,
      orderInfo: input.orderInfo,
      partnerCode: settings.partnerCode,
      redirectUrl: settings.redirectUrl,
      requestId: input.requestId,
      requestType: MOMO_REQUEST.requestType,
    };
    return {
      ...signed,
      lang: MOMO_REQUEST.lang,
      signature: generateMomoSignature('create', signed, settings),
    };
  }

  /** One create call (`/v2/gateway/api/create`) for one payment attempt. */
  async create(settings: MomoCreateSettings, input: MomoCreateInput): Promise<MomoCreateAnswer> {
    const ref = `MoMo create ${input.orderId}`;
    const response = await this.post(
      MOMO_PATHS.create,
      this.createBody(settings, input),
      this.config.get('MOMO_REQUEST_TIMEOUT_MS'),
    );
    if (response.kind === 'failed') {
      this.logger.warn(`${ref}: no answer (${response.reason}); the attempt stays open`);
      return { kind: 'unavailable', reason: response.reason, timedOut: response.timedOut };
    }

    const { status, body } = response;
    const resultCode = integerOf(body.resultCode);
    if (resultCode === null) {
      const reason = `HTTP ${status} without a MoMo resultCode`;
      this.logger.warn(`${ref}: ${reason}; the attempt stays open`);
      return { kind: 'unavailable', reason, timedOut: false };
    }
    const message = typeof body.message === 'string' ? body.message : '';

    if (resultCode === MOMO_RESULT_SUCCESS) {
      const mismatch = this.createMismatch(body, settings, input);
      if (mismatch) {
        this.logger.error(`${ref}: resultCode 0 but ${mismatch}; the attempt stays open`);
        return { kind: 'unavailable', reason: mismatch, timedOut: false };
      }
      this.logger.log(`${ref}: created (resultCode 0)`);
      return { kind: 'created', payUrl: body.payUrl as string, resultCode };
    }
    if (momoResultState(resultCode) === MomoResultState.PENDING) {
      // 7000 with HTTP 422: the same requestId is still being processed (API Idempotency).
      const reason = `resultCode ${resultCode} (not final) with HTTP ${status}`;
      this.logger.warn(`${ref}: ${reason}; the attempt stays open`);
      return { kind: 'unavailable', reason, timedOut: false };
    }
    this.logger.warn(`${ref}: refused (resultCode ${resultCode}, HTTP ${status})`);
    return { kind: 'refused', resultCode, message, body: withoutSignature(body) };
  }

  /**
   * Asks MoMo about one order (`/v2/gateway/api/query`). Used by the booking expiry **outside**
   * any transaction (PLAN §4). Only an answer that is about exactly this order, from this
   * merchant, to this very query, with `resultCode` 0, is PAID; its amount is checked later by
   * `settlePayment` under the payment row lock, as for an IPN.
   *
   * The answer is authenticated by TLS to `MOMO_ENDPOINT`, not by a signature: the response
   * signature of this API could not be read verbatim from MoMo's documentation (see
   * docs/MOMO_SETUP.md), and a wrong guess would only make every answer unverifiable.
   */
  async query(orderId: string): Promise<MomoQueryAnswer> {
    const merchant = this.merchant();
    if (!merchant || this.endpoint() === null) {
      return this.unknown(orderId, 'MoMo keys or MOMO_ENDPOINT unset');
    }
    const requestId = newMomoRequestId();
    const signed = { orderId, partnerCode: merchant.partnerCode, requestId };
    const response = await this.post(
      MOMO_PATHS.query,
      {
        ...signed,
        lang: MOMO_REQUEST.lang,
        signature: generateMomoSignature('query', signed, merchant),
      },
      this.config.get('MOMO_QUERY_TIMEOUT_MS'),
    );
    if (response.kind === 'failed') return this.unknown(orderId, response.reason);

    const { body } = response;
    const resultCode = integerOf(body.resultCode);
    if (resultCode === null) {
      return this.unknown(orderId, `HTTP ${response.status} without a MoMo resultCode`);
    }
    if (body.orderId !== orderId || body.partnerCode !== merchant.partnerCode) {
      return this.unknown(orderId, 'the answer is about another order or merchant', resultCode);
    }
    if (body.requestId !== requestId) {
      return this.unknown(orderId, 'the answer is not to this query (requestId)', resultCode);
    }

    const state = momoResultState(resultCode);
    if (state === MomoResultState.FAILED) {
      this.logger.log(`MoMo query ${orderId}: not paid (resultCode ${resultCode})`);
      return {
        verdict: MomoQueryVerdict.NOT_PAID,
        report: null,
        resultCode,
        reason: `resultCode ${resultCode}`,
      };
    }
    if (state === MomoResultState.PENDING) {
      return this.unknown(orderId, `resultCode ${resultCode} is not final`, resultCode);
    }
    const amount = integerOf(body.amount);
    const transId = integerOf(body.transId);
    if (amount === null || transId === null || transId <= 0) {
      return this.unknown(orderId, 'resultCode 0 without a usable amount or transId', resultCode);
    }
    this.logger.log(`MoMo query ${orderId}: paid (resultCode 0, transId ${transId})`);
    return {
      verdict: MomoQueryVerdict.PAID,
      report: {
        amount: String(amount),
        paid: true,
        responseCode: String(resultCode),
        transactionStatus: null,
        bankCode: null,
        transactionNo: String(transId),
        raw: body as PaymentReport['raw'],
      },
      resultCode,
      reason: 'MoMo reports the order paid',
    };
  }

  /** Why a `resultCode 0` create answer cannot be used for this request, or `null`. */
  private createMismatch(
    body: Record<string, unknown>,
    settings: MomoCreateSettings,
    input: MomoCreateInput,
  ): string | null {
    if (body.orderId !== input.orderId) return 'the answer is about another orderId';
    if (body.requestId !== input.requestId) return 'the answer is about another requestId';
    if (body.partnerCode !== settings.partnerCode) return 'the answer is for another partnerCode';
    if (integerOf(body.amount) !== input.amount) return 'the answer has another amount';
    if (typeof body.payUrl !== 'string' || !URL.canParse(body.payUrl)) return 'no usable payUrl';
    if (!/^https?:$/.test(new URL(body.payUrl).protocol)) return 'payUrl is not http(s)';
    return null;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<
    | { kind: 'ok'; status: number; body: Record<string, unknown> }
    | { kind: 'failed'; reason: string; timedOut: boolean }
  > {
    const endpoint = this.endpoint();
    // Unreachable through create() and query(), which check it first; never fall back to a default.
    if (endpoint === null)
      return { kind: 'failed', reason: 'MOMO_ENDPOINT unset', timedOut: false };
    let response: Response;
    try {
      response = await fetch(`${endpoint}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return failure(error, timeoutMs);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // The timeout also covers reading the body: MoMo may still have accepted the request.
      if (errorName(error) === 'TimeoutError') return failure(error, timeoutMs);
      return {
        kind: 'failed',
        reason: `HTTP ${response.status} with a non-JSON body`,
        timedOut: false,
      };
    }
    if (!isRecord(payload)) {
      return {
        kind: 'failed',
        reason: `HTTP ${response.status}, body is not a JSON object`,
        timedOut: false,
      };
    }
    return { kind: 'ok', status: response.status, body: payload };
  }

  private unknown(
    orderId: string,
    reason: string,
    resultCode: number | null = null,
  ): MomoQueryAnswer {
    this.logger.warn(`MoMo query ${orderId}: unknown — ${reason}; expiring as usual`);
    return { verdict: MomoQueryVerdict.UNKNOWN, report: null, resultCode, reason };
  }
}
