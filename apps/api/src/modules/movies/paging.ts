import type { Page } from '@ticketify/shared';

export interface Paging {
  page: number;
  pageSize: number;
  skip: number;
}

/** Applies defaults to an already validated query (`page ≥ 1`, `1 ≤ pageSize ≤ max`). */
export function resolvePaging(
  query: { page?: number; pageSize?: number },
  defaultPageSize: number,
): Paging {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? defaultPageSize;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function pageOf<T>(items: T[], total: number, paging: Paging): Page<T> {
  return { items, total, page: paging.page, pageSize: paging.pageSize };
}
