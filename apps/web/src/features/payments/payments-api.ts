import {
  type CreatedVnpayPayment,
  createdVnpayPaymentSchema,
  type VnpayReturnResult,
  vnpayReturnResultSchema,
} from '@ticketify/shared';
import { apiClient } from '@/lib/api-client';

/** `POST /payments/vnpay`: a new payment attempt and the signed VNPay URL to send the browser to. */
export async function createVnpayPayment(bookingId: string): Promise<CreatedVnpayPayment> {
  const res = await apiClient.post<unknown>('/payments/vnpay', { bookingId });
  return createdVnpayPaymentSchema.parse(res.data);
}

/**
 * `GET /payments/vnpay/return` with the query VNPay sent the browser back with, passed on byte for
 * byte (`search` without its `?`): the signature covers the values, so the query is never
 * rebuilt or re-encoded here.
 */
export async function checkVnpayReturn(search: string): Promise<VnpayReturnResult> {
  const res = await apiClient.get<unknown>(`/payments/vnpay/return?${search}`);
  return vnpayReturnResultSchema.parse(res.data);
}

export const paymentKeys = {
  vnpayReturn: (search: string) => ['payments', 'vnpay-return', search] as const,
};
