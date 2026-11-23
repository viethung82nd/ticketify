import { randomInt } from 'node:crypto';

/**
 * The payment code a SePay attempt is identified by: `SEPAY_PAYMENT_CODE_PREFIX` + 8 digits, e.g.
 * `TKF04817263`. It is the attempt's `txn_ref` (unique across every payment of every gateway) and
 * the whole transfer content the customer types.
 *
 * Digits only after the prefix, so it matches SePay's "Cấu trúc mã thanh toán" whichever suffix
 * type is chosen ("Số nguyên" or "Số và chữ"), and 8 of them fits both the Live default (6–8) and
 * the Test-mode default (3–10). Random, not sequential: a code does not reveal how many payments
 * exist, and a collision with an existing `txn_ref` is simply drawn again.
 */
export const PAYMENT_CODE_DIGITS = 8;

export function newPaymentCode(prefix: string): string {
  return `${prefix}${String(randomInt(0, 10 ** PAYMENT_CODE_DIGITS)).padStart(PAYMENT_CODE_DIGITS, '0')}`;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The payment code a transfer names, upper-cased, or `null`. SePay's own `code` comes first; when
 * it is empty or another format (another prefix configured in SePay, the code-detection toggle
 * off), `content` is searched for `prefix` + exactly 8 digits not glued to other letters or
 * digits: banks prepend and append their own text ("MBVCB.123.TKF04817263.CT tu ...") and may
 * change the case. A content naming two different codes is ambiguous and names none.
 */
export function referenceOf(
  transfer: { code?: string | null; content?: string | null },
  prefix: string,
): string | null {
  const exact = new RegExp(`^${escapeRegExp(prefix)}\\d{${PAYMENT_CODE_DIGITS}}$`, 'i');
  const code = transfer.code?.trim();
  if (code && exact.test(code)) return code.toUpperCase();

  const anywhere = new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(prefix)}\\d{${PAYMENT_CODE_DIGITS}}(?![A-Za-z0-9])`,
    'gi',
  );
  const found = new Set((transfer.content ?? '').match(anywhere)?.map((m) => m.toUpperCase()));
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/**
 * VietQR image the customer scans (developer.sepay.vn/vi/tien-ich-khac/tao-qr-code, 23/11/2026):
 * `https://vietqr.app/img?acc=&bank=&amount=&des=`, plus `template=compact` and the optional
 * holder. Nothing secret goes into it: an account number, a bank, an amount and the payment code.
 */
export const VIETQR_IMAGE_URL = 'https://vietqr.app/img';

export interface QrInput {
  accountNumber: string;
  bankCode: string;
  accountHolder: string | null;
  amount: number;
  transferContent: string;
}

export function vietQrUrl(input: QrInput): string {
  const params = new URLSearchParams({
    acc: input.accountNumber,
    bank: input.bankCode,
    amount: String(input.amount),
    des: input.transferContent,
    template: 'compact',
  });
  if (input.accountHolder) params.set('holder', input.accountHolder);
  return `${VIETQR_IMAGE_URL}?${params.toString()}`;
}
