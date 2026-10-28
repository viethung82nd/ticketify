import {
  type DayType,
  type Holiday,
  type HolidayRequest,
  holidaySchema,
  type SeatPrice,
  type SeatPriceRequest,
  seatPriceSchema,
  type SeatType,
} from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';

export async function listSeatPrices(): Promise<SeatPrice[]> {
  const res = await apiClient.get<unknown>('/admin/seat-prices');
  return z.array(seatPriceSchema).parse(res.data);
}

export async function updateSeatPrice(
  seatType: SeatType,
  dayType: DayType,
  body: SeatPriceRequest,
): Promise<SeatPrice> {
  const res = await apiClient.put<unknown>(`/admin/seat-prices/${seatType}/${dayType}`, body);
  return seatPriceSchema.parse(res.data);
}

export async function listHolidays(year: number): Promise<Holiday[]> {
  const res = await apiClient.get<unknown>('/admin/holidays', { params: { year } });
  return z.array(holidaySchema).parse(res.data);
}

export async function createHoliday(body: HolidayRequest): Promise<Holiday> {
  const res = await apiClient.post<unknown>('/admin/holidays', body);
  return holidaySchema.parse(res.data);
}

export async function deleteHoliday(id: string): Promise<void> {
  await apiClient.delete(`/admin/holidays/${id}`);
}

export const pricingKeys = {
  prices: ['pricing', 'prices'] as const,
  holidays: (year: number) => ['pricing', 'holidays', year] as const,
};

export const useSeatPrices = () =>
  useQuery({ queryKey: pricingKeys.prices, queryFn: listSeatPrices });

export const useHolidays = (year: number) =>
  useQuery({ queryKey: pricingKeys.holidays(year), queryFn: () => listHolidays(year) });
