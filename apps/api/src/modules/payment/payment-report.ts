import { PaymentProvider } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';
import { vnpayAmount } from './vnpay/vnpay-format';

/**
 * A gateway's answer about one payment attempt, in the terms `settlePayment` records it. Built
 * only from an answer whose signature was checked, by that gateway's reader: `readVnpayReport`
 * (VNPay IPN and querydr), `readMomoReport` (MoMo IPN and query) or `sepayReport` (SePay
 * webhook, incoming transfers only). An answer that says the
 * transaction is still in progress never becomes a report: it changes nothing.
 */
export interface PaymentReport {
  /**
   * The amount the gateway reports, in its own textual form (VNPay: hundredths of a dong, MoMo:
   * dong), compared as a string with `gatewayAmount`; `null` when absent.
   */
  amount: string | null;
  /** The gateway reports the money taken. Otherwise the attempt failed. */
  paid: boolean;
  /** VNPay `vnp_ResponseCode`, MoMo `resultCode`. */
  responseCode: string | null;
  /** VNPay `vnp_TransactionStatus`; `null` for MoMo. For the log only. */
  transactionStatus: string | null;
  bankCode: string | null;
  /** The gateway's own transaction id (`vnp_TransactionNo`, MoMo `transId`); stored once paid. */
  transactionNo: string | null;
  /** Everything the gateway sent, stored verbatim as `raw_payload`. */
  raw: Prisma.InputJsonObject;
}

/** What a gateway must report as the amount of a payment of `amount` VND (MoMo, SePay: dong). */
export function gatewayAmount(provider: PaymentProvider, amount: number): string {
  return provider === PaymentProvider.VNPAY ? vnpayAmount(amount) : String(amount);
}

/** How a gateway is named to a person (logs, admin notifications). */
export const PROVIDER_LABELS: Readonly<Record<PaymentProvider, string>> = {
  [PaymentProvider.VNPAY]: 'VNPay',
  [PaymentProvider.MOMO]: 'MoMo',
  [PaymentProvider.SEPAY]: 'SePay',
};
