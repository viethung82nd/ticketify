import {
  type NeedsReviewBooking,
  needsReviewBookingSchema,
  needsReviewPageSchema,
  type Page,
  REVIEW_LIMITS,
  type ReviewFilter,
} from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export interface NeedsReviewParams {
  filter: ReviewFilter;
  page: number;
}

/** `GET /admin/bookings/needs-review`: paid bookings that lost their seats (ROADMAP 3.8). */
export async function listNeedsReview(
  params: NeedsReviewParams,
): Promise<Page<NeedsReviewBooking>> {
  const res = await apiClient.get<unknown>('/admin/bookings/needs-review', {
    params: { ...params, pageSize: REVIEW_LIMITS.listPageSizeDefault },
  });
  return needsReviewPageSchema.parse(res.data);
}

/**
 * `POST /admin/bookings/:id/resolve-review`: record that the booking was handled outside the
 * system. Refunds nothing and leaves the booking NEEDS_REVIEW.
 */
export async function resolveReview(bookingId: string, note: string): Promise<NeedsReviewBooking> {
  const res = await apiClient.post<unknown>(`/admin/bookings/${bookingId}/resolve-review`, {
    note,
  });
  return needsReviewBookingSchema.parse(res.data);
}

export const reviewKeys = {
  all: ['admin', 'needs-review'] as const,
  page: (params: NeedsReviewParams) => ['admin', 'needs-review', params] as const,
};

export const useNeedsReview = (params: NeedsReviewParams) =>
  useQuery({ queryKey: reviewKeys.page(params), queryFn: () => listNeedsReview(params) });
