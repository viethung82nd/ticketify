import { randomUUID, timingSafeEqual } from 'node:crypto';
import { vnpaySignature } from './vnpay.service';

/**
 * VNPay's transaction query API, `vnp_Command=querydr` (ROADMAP 3.7). Pure: no HTTP, no clock, no
 * configuration — `VnpayQuerydrClient` makes the request, this file builds and reads its body.
 *
 * Documentation read 06/11/2026:
 * `https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr&refund.html`
 * (`POST https://sandbox.vnpayment.vn/merchant_webapi/api/transaction`, `Application/json`; the
 * page lists no production URL, hence the `VNPAY_API_URL` variable). Unlike the payment URL and
 * the IPN, the signed data here is **not** the sorted query string: it is the documentation's own
 * `|`-joined list of values in a fixed order, so `VnpayService.buildSignedQuery` cannot be used.
 */

/** Fixed by the API, not by this application. */
export const QUERYDR = { version: '2.1.0', command: 'querydr' } as const;

/**
 * `vnp_IpAddr` of a query ("IP của server gọi API"). The worker has no request to take an address
 * from and does not know its own outbound address, so it sends the unspecified address, as
 * `vnpayIpAddr` does for a request whose socket is already gone. 7 characters: the documented
 * minimum for the field.
 */
export const QUERYDR_IP_ADDR = '0.0.0.0';

export interface QuerydrRequest {
  tmnCode: string;
  /** `vnp_TxnRef` of the payment attempt being asked about. */
  txnRef: string;
  /** `vnp_TransactionDate`: the `vnp_CreateDate` the payment URL was built with (GMT+7). */
  transactionDate: string;
  /** `vnp_CreateDate`: when this query is made (GMT+7). */
  createDate: string;
  /** `vnp_OrderInfo`: unaccented description of the query. */
  orderInfo: string;
}

/**
 * A new `vnp_RequestId`: the 32 hex characters of a UUIDv4, inside Alphanumeric[1,32]. The
 * documentation only asks that it not repeat within the day.
 */
export const newRequestId = (): string => randomUUID().replace(/-/g, '');

/**
 * The body of one querydr request, signed. The hash covers the documentation's field order,
 * verbatim: `vnp_RequestId|vnp_Version|vnp_Command|vnp_TmnCode|vnp_TxnRef|vnp_TransactionDate|
 * vnp_CreateDate|vnp_IpAddr|vnp_OrderInfo`. `vnp_TransactionNo` is an optional request parameter
 * that the documentation leaves out of the hash; it is not sent at all.
 */
export function querydrBody(
  request: QuerydrRequest,
  hashSecret: string,
  requestId: string = newRequestId(),
): Record<string, string> {
  const body = {
    vnp_RequestId: requestId,
    vnp_Version: QUERYDR.version,
    vnp_Command: QUERYDR.command,
    vnp_TmnCode: request.tmnCode,
    vnp_TxnRef: request.txnRef,
    vnp_OrderInfo: request.orderInfo,
    vnp_TransactionDate: request.transactionDate,
    vnp_CreateDate: request.createDate,
    vnp_IpAddr: QUERYDR_IP_ADDR,
  };
  const data = [
    body.vnp_RequestId,
    body.vnp_Version,
    body.vnp_Command,
    body.vnp_TmnCode,
    body.vnp_TxnRef,
    body.vnp_TransactionDate,
    body.vnp_CreateDate,
    body.vnp_IpAddr,
    body.vnp_OrderInfo,
  ].join('|');
  return { ...body, vnp_SecureHash: vnpaySignature(data, hashSecret) };
}

/** Fields of the querydr response the response hash covers, in the documentation's order. */
const RESPONSE_HASH_FIELDS = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
  'vnp_PromotionCode',
  'vnp_PromotionAmount',
] as const;

/**
 * The data a querydr response's `vnp_SecureHash` covers. Two gaps in the documentation, both read
 * on the safe side (an unverifiable response is never taken as a payment):
 * - the page writes `+ "|" vnp_BankCode`, dropping the `+` before `vnp_BankCode`; read as the same
 *   `|` separator as every other field, the only consistent reading;
 * - it does not say what to use for the optional `vnp_PayDate`, `vnp_PromotionCode` and
 *   `vnp_PromotionAmount` when they are absent; read as the empty string, which is what the
 *   concatenation gives for a missing value.
 * Either reading being wrong only ever makes a response unverifiable, which the expiry treats as
 * "unknown" and handles exactly as before 3.7 (ROADMAP "Đã chốt").
 */
export function querydrResponseHashData(body: Readonly<Record<string, unknown>>): string {
  return RESPONSE_HASH_FIELDS.map((field) => {
    const value = body[field];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }).join('|');
}

/** `true` when the response carries a `vnp_SecureHash` this merchant's secret reproduces. */
export function verifyQuerydrResponse(
  body: Readonly<Record<string, unknown>>,
  hashSecret: string,
): boolean {
  const received = body.vnp_SecureHash;
  if (typeof received !== 'string' || received.length === 0) return false;
  const expected = Buffer.from(vnpaySignature(querydrResponseHashData(body), hashSecret), 'utf8');
  const actual = Buffer.from(received.toLowerCase(), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** What one querydr answer lets the expiry conclude about the money. */
export const QuerydrVerdict = {
  /** VNPay reports the payment went through: `vnp_ResponseCode` and `vnp_TransactionStatus` `00`. */
  PAID: 'paid',
  /** VNPay answered, and the money is not coming: no such transaction, or it failed. */
  NOT_PAID: 'not_paid',
  /**
   * No answer this application may act on: network error, timeout, unverifiable signature, a
   * transaction still in flight (`01`, `04`), one under investigation (`07`), or a query the API
   * itself refused (`02`, `03`, `94`, `97`, `99`). The expiry treats it exactly like `NOT_PAID`
   * (the booking expires, a late IPN still records the result) but logs a warning.
   */
  UNKNOWN: 'unknown',
} as const;
export type QuerydrVerdict = (typeof QuerydrVerdict)[keyof typeof QuerydrVerdict];

/** `vnp_ResponseCode` of a querydr answer: the query's own result, not the payment's. */
const QUERY_OK = '00';
/** `vnp_ResponseCode` `91`: VNPay has no such transaction, so no money ever arrived. */
const QUERY_NOT_FOUND = '91';
/** `vnp_TransactionStatus` `00`: paid. */
const PAYMENT_PAID = '00';
/** `vnp_TransactionStatus` that settle the question the other way: `02` failed, `09` refund refused. */
const PAYMENT_SETTLED_UNPAID: ReadonlySet<string> = new Set(['02', '09']);

export interface QuerydrAnswer {
  verdict: QuerydrVerdict;
  /** The response as received, string values only; the `raw_payload` of a `paid` answer. */
  params: Record<string, string>;
  /** `vnp_ResponseCode`: the query's result. */
  responseCode: string | null;
  /** `vnp_TransactionStatus`: the payment's state at VNPay. */
  transactionStatus: string | null;
  /** One line for the log: why this verdict. Never a signature, never the secret. */
  reason: string;
}

/**
 * Reads a querydr response body for the payment `txnRef` asked about. Anything that does not
 * clearly say "paid" comes back `NOT_PAID` or `UNKNOWN`: an unverifiable signature, a
 * `vnp_TxnRef` that is not the one asked about, a missing status, a transaction still in flight.
 *
 * `vnp_Amount` is deliberately **not** checked here. The caller hands the response to
 * `confirmPayment`, which compares it with the payment row under its lock exactly as it does for
 * an IPN; a mismatch there writes nothing and the booking expires as usual.
 */
export function readQuerydrAnswer(
  body: Readonly<Record<string, unknown>>,
  txnRef: string,
  hashSecret: string,
): QuerydrAnswer {
  const params = Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const responseCode = params.vnp_ResponseCode ?? null;
  const transactionStatus = params.vnp_TransactionStatus ?? null;
  const answer = (verdict: QuerydrVerdict, reason: string): QuerydrAnswer => ({
    verdict,
    params,
    responseCode,
    transactionStatus,
    reason,
  });

  if (!verifyQuerydrResponse(body, hashSecret)) {
    return answer(QuerydrVerdict.UNKNOWN, 'the response signature does not match');
  }
  if (params.vnp_TxnRef !== txnRef) {
    return answer(
      QuerydrVerdict.UNKNOWN,
      `the response is about vnp_TxnRef ${params.vnp_TxnRef ?? '(none)'}, not ${txnRef}`,
    );
  }
  if (responseCode === QUERY_NOT_FOUND) {
    return answer(QuerydrVerdict.NOT_PAID, 'VNPay has no such transaction (vnp_ResponseCode 91)');
  }
  if (responseCode !== QUERY_OK) {
    return answer(
      QuerydrVerdict.UNKNOWN,
      `the query itself failed (vnp_ResponseCode ${responseCode ?? '(none)'})`,
    );
  }
  if (transactionStatus === PAYMENT_PAID) {
    return answer(QuerydrVerdict.PAID, 'VNPay reports the payment went through');
  }
  if (transactionStatus !== null && PAYMENT_SETTLED_UNPAID.has(transactionStatus)) {
    return answer(
      QuerydrVerdict.NOT_PAID,
      `the payment did not go through (vnp_TransactionStatus ${transactionStatus})`,
    );
  }
  return answer(
    QuerydrVerdict.UNKNOWN,
    `the payment is not settled yet (vnp_TransactionStatus ${transactionStatus ?? '(none)'})`,
  );
}
