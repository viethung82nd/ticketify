import type { VnpayQuery } from './vnpay.service';

/** What the IPN URL answers VNPay, as JSON (pay.html, "Cài đặt Code IPN URL"). */
export interface VnpayIpnResponse {
  RspCode: string;
  Message: string;
}

/**
 * The `RspCode`s of the VNPay IPN (pay.html, checked 29/10/2026). VNPay ends the flow on `00` and
 * `02` ("the merchant recorded the result"); on `01`, `04`, `97`, `99` or a timeout it calls the
 * IPN again: at most 10 calls in all, 5 minutes apart.
 */
export const VnpayIpnResponse = {
  /** The result was recorded now (success or failure alike). */
  CONFIRM_SUCCESS: { RspCode: '00', Message: 'Confirm Success' },
  /** This payment's result was recorded before: nothing changes. */
  ALREADY_CONFIRMED: { RspCode: '02', Message: 'Order already confirmed' },
  ORDER_NOT_FOUND: { RspCode: '01', Message: 'Order not found' },
  INVALID_AMOUNT: { RspCode: '04', Message: 'Invalid amount' },
  INVALID_SIGNATURE: { RspCode: '97', Message: 'Invalid signature' },
  /**
   * Anything unexpected (database, timeout): sent with HTTP 500 and nothing written, so VNPay
   * calls again. `99` is the documentation's own code for it ("Unknow error").
   */
  UNKNOWN_ERROR: { RspCode: '99', Message: 'Unknown error' },
} as const satisfies Record<string, VnpayIpnResponse>;

/** `vnp_ResponseCode` and `vnp_TransactionStatus` of a successful payment. */
const VNPAY_OK = '00';

/** The fields of an IPN this application stores, from a query whose signature was checked. */
export interface VnpayIpnResult {
  /** Paid: `vnp_ResponseCode` AND `vnp_TransactionStatus` are both `00`. */
  succeeded: boolean;
  responseCode: string | null;
  transactionStatus: string | null;
  bankCode: string | null;
  transactionNo: string | null;
}

/**
 * Reads an IPN whose signature is valid. A payment counts as successful only when both codes are
 * `00`: the parameter table says "`vnp_TransactionStatus` khác 00: giao dịch không thành công", and
 * of the documentation's samples C# checks both, Java/Python only `vnp_ResponseCode` and PHP either
 * one. Requiring both is the strictest reading; anything else is a failure.
 */
export function readVnpayIpn(params: Readonly<Record<string, string>>): VnpayIpnResult {
  const responseCode = params.vnp_ResponseCode ?? null;
  const transactionStatus = params.vnp_TransactionStatus ?? null;
  return {
    succeeded: responseCode === VNPAY_OK && transactionStatus === VNPAY_OK,
    responseCode,
    transactionStatus,
    bankCode: params.vnp_BankCode || null,
    transactionNo: params.vnp_TransactionNo || null,
  };
}

/**
 * The parameters of a query `VnpayService.verifySignature` accepted, typed as strings (it rejects
 * any query with a non-string value, so nothing is dropped here).
 */
export function signedParams(query: VnpayQuery): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
