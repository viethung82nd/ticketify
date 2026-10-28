import {
  type AdminRoom,
  adminRoomSchema,
  type AdminRoomSummary,
  adminRoomSummarySchema,
  type CreateRoomRequest,
  type RenameRoomRequest,
  type UpdateSeatsRequest,
} from '@ticketify/shared';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

export async function listRooms(): Promise<AdminRoomSummary[]> {
  const res = await apiClient.get<unknown>('/admin/rooms');
  return z.array(adminRoomSummarySchema).parse(res.data);
}

export async function getRoom(id: string): Promise<AdminRoom> {
  const res = await apiClient.get<unknown>(`/admin/rooms/${id}`);
  return adminRoomSchema.parse(res.data);
}

export async function createRoom(body: CreateRoomRequest): Promise<AdminRoom> {
  const res = await apiClient.post<unknown>('/admin/rooms', body);
  return adminRoomSchema.parse(res.data);
}

export async function renameRoom(id: string, body: RenameRoomRequest): Promise<AdminRoom> {
  const res = await apiClient.patch<unknown>(`/admin/rooms/${id}`, body);
  return adminRoomSchema.parse(res.data);
}

export async function deleteRoom(id: string): Promise<void> {
  await apiClient.delete(`/admin/rooms/${id}`);
}

/** All-or-nothing; returns the whole new grid. */
export async function updateSeats(id: string, body: UpdateSeatsRequest): Promise<AdminRoom> {
  const res = await apiClient.patch<unknown>(`/admin/rooms/${id}/seats`, body);
  return adminRoomSchema.parse(res.data);
}
