import {
  type AdminBooking,
  adminBookingPageSchema,
  type BookingStatus,
  type OccupancyReport,
  occupancyReportSchema,
  type Page,
  type RevenueReport,
  revenueReportSchema,
} from '@ticketify/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

/** Filters of the admin booking list, as kept in the page URL. Empty = not filtered. */
export interface AdminBookingsParams {
  status?: BookingStatus;
  q?: string;
  from?: string;
  to?: string;
  page: number;
}

/** `GET /admin/bookings` (ROADMAP 5.5): every booking, newest first. */
export async function listAdminBookings(params: AdminBookingsParams): Promise<Page<AdminBooking>> {
  const res = await apiClient.get<unknown>('/admin/bookings', { params });
  return adminBookingPageSchema.parse(res.data);
}

/** `GET /admin/dashboard/revenue`: revenue per cinema day, `from`..`to` included. */
export async function getRevenue(range: { from: string; to: string }): Promise<RevenueReport> {
  const res = await apiClient.get<unknown>('/admin/dashboard/revenue', { params: range });
  return revenueReportSchema.parse(res.data);
}

/** `GET /admin/dashboard/occupancy`: the showtimes of one cinema day and their seats. */
export async function getOccupancy(date: string): Promise<OccupancyReport> {
  const res = await apiClient.get<unknown>('/admin/dashboard/occupancy', { params: { date } });
  return occupancyReportSchema.parse(res.data);
}

export const adminReportKeys = {
  bookings: (params: AdminBookingsParams) => ['admin', 'bookings', params] as const,
  revenue: (from: string, to: string) => ['admin', 'dashboard', 'revenue', from, to] as const,
  occupancy: (date: string) => ['admin', 'dashboard', 'occupancy', date] as const,
};

/** The previous page stays on screen while the next one loads (no flash of the skeleton). */
export const useAdminBookings = (params: AdminBookingsParams) =>
  useQuery({
    queryKey: adminReportKeys.bookings(params),
    queryFn: () => listAdminBookings(params),
    placeholderData: keepPreviousData,
  });

export const useRevenue = (from: string, to: string) =>
  useQuery({
    queryKey: adminReportKeys.revenue(from, to),
    queryFn: () => getRevenue({ from, to }),
    placeholderData: keepPreviousData,
  });

/** Seats move while the admin watches: refreshed every 30 s. */
export const useOccupancy = (date: string) =>
  useQuery({
    queryKey: adminReportKeys.occupancy(date),
    queryFn: () => getOccupancy(date),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
