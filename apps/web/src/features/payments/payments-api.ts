import {
  type CreatedMomoPayment,
  createdMomoPaymentSchema,
  type CreatedVnpayPayment,
  createdVnpayPaymentSchema,
  type MomoReturnResult,
  momoReturnResultSchema,
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
 * `POST /payments/momo`: the booking's MoMo payment page. Only the booking id is sent: the amount
 * always comes from the booking on the server. Calling again while the attempt is open hands the
 * same page back.
 */
export async function createMomoPayment(bookingId: string): Promise<CreatedMomoPayment> {
  const res = await apiClient.post<unknown>('/payments/momo', { bookingId });
  return createdMomoPaymentSchema.parse(res.data);
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

/** `GET /payments/momo/return`, the same way: MoMo's redirect query passed on unchanged. */
export async function checkMomoReturn(search: string): Promise<MomoReturnResult> {
  const res = await apiClient.get<unknown>(`/payments/momo/return?${search}`);
  return momoReturnResultSchema.parse(res.data);
}

export const paymentKeys = {
  vnpayReturn: (search: string) => ['payments', 'vnpay-return', search] as const,
  momoReturn: (search: string) => ['payments', 'momo-return', search] as const,
};
