import {
  type AdminCombo,
  adminComboSchema,
  type CreateComboRequest,
  type UpdateComboRequest,
} from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

export async function listAdminCombos(): Promise<AdminCombo[]> {
  const res = await apiClient.get<unknown>('/admin/combos');
  return z.array(adminComboSchema).parse(res.data);
}

export async function createCombo(body: CreateComboRequest): Promise<AdminCombo> {
  const res = await apiClient.post<unknown>('/admin/combos', body);
  return adminComboSchema.parse(res.data);
}

export async function updateCombo(id: string, body: UpdateComboRequest): Promise<AdminCombo> {
  const res = await apiClient.patch<unknown>(`/admin/combos/${id}`, body);
  return adminComboSchema.parse(res.data);
}

export async function deleteCombo(id: string): Promise<void> {
  await apiClient.delete(`/admin/combos/${id}`);
}

export const comboKeys = { admin: ['combos', 'admin'] as const };

export const useAdminCombos = () =>
  useQuery({ queryKey: comboKeys.admin, queryFn: listAdminCombos });
