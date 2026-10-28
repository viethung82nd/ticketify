import {
  type AdminCombo,
  adminComboSchema,
  type Combo,
  comboSchema,
  type CreateComboRequest,
  type UpdateComboRequest,
} from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

/** `GET /combos`: combos on sale, by name (public). */
export async function listCombos(): Promise<Combo[]> {
  const res = await apiClient.get<unknown>('/combos');
  return z.array(comboSchema).parse(res.data);
}

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

export const comboKeys = {
  public: ['combos', 'public'] as const,
  admin: ['combos', 'admin'] as const,
};

export const useCombos = () => useQuery({ queryKey: comboKeys.public, queryFn: listCombos });

export const useAdminCombos = () =>
  useQuery({ queryKey: comboKeys.admin, queryFn: listAdminCombos });
