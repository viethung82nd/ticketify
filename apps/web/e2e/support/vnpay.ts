import { createHmac } from 'node:crypto';
import { VNPAY } from '../../playwright.config';

/** VNPay's encoding of a query value (RFC 3986 plus `+` for space), as in its Node sample. */
const encode = (value: string): string =>
  encodeURIComponent(value)
    .replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

/**
 * `params` as VNPay sends them to the IPN and the return URL: sorted, encoded and signed with
 * HMAC-SHA512 of the merchant secret (the test-only one the API was started with).
 */
export function signedQuery(params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key] ?? '')}`)
    .join('&');
  const hash = createHmac('sha512', VNPAY.hashSecret).update(data).digest('hex');
  return `${data}&vnp_SecureHash=${hash}`;
}

/**
 * What VNPay answers after a successful card payment of the request the web app sent it
 * (`payUrl`: the intercepted redirect), for the IPN and the return page alike.
 */
export function paidResult(payUrl: string, transactionNo: string): string {
  const sent = new URL(payUrl).searchParams;
  const get = (key: string) => sent.get(key) ?? '';
  return signedQuery({
    vnp_Amount: get('vnp_Amount'),
    vnp_BankCode: 'NCB',
    vnp_BankTranNo: `VNP${transactionNo}`,
    vnp_CardType: 'ATM',
    vnp_OrderInfo: get('vnp_OrderInfo'),
    vnp_PayDate: get('vnp_CreateDate'),
    vnp_ResponseCode: '00',
    vnp_TmnCode: get('vnp_TmnCode'),
    vnp_TransactionNo: transactionNo,
    vnp_TransactionStatus: '00',
    vnp_TxnRef: get('vnp_TxnRef'),
  });
}
