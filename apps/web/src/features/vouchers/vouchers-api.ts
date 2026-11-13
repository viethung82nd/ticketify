import {
  type AdminVoucher,
  adminVoucherSchema,
  type CreateVoucherRequest,
  type UpdateVoucherRequest,
} from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

/** `GET /admin/vouchers`: every voucher, newest first, with uses per status. */
export async function listAdminVouchers(): Promise<AdminVoucher[]> {
  const res = await apiClient.get<unknown>('/admin/vouchers');
  return z.array(adminVoucherSchema).parse(res.data);
}

export async function createVoucher(body: CreateVoucherRequest): Promise<AdminVoucher> {
  const res = await apiClient.post<unknown>('/admin/vouchers', body);
  return adminVoucherSchema.parse(res.data);
}

export async function updateVoucher(id: string, body: UpdateVoucherRequest): Promise<AdminVoucher> {
  const res = await apiClient.patch<unknown>(`/admin/vouchers/${id}`, body);
  return adminVoucherSchema.parse(res.data);
}

export async function deleteVoucher(id: string): Promise<void> {
  await apiClient.delete(`/admin/vouchers/${id}`);
}

export const voucherKeys = {
  admin: ['vouchers', 'admin'] as const,
};

export const useAdminVouchers = () =>
  useQuery({ queryKey: voucherKeys.admin, queryFn: listAdminVouchers });
