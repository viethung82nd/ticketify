import { AgeRating, MovieStatus } from '@ticketify/shared';

export const STATUS_LABELS: Record<MovieStatus, string> = {
  [MovieStatus.NOW_SHOWING]: 'Đang chiếu',
  [MovieStatus.COMING_SOON]: 'Sắp chiếu',
  [MovieStatus.ENDED]: 'Đã kết thúc',
};

/** Thông tư 05/2023/TT-BVHTTDL. */
export const AGE_RATING_LABELS: Record<AgeRating, string> = {
  [AgeRating.P]: 'P — Mọi lứa tuổi',
  [AgeRating.K]: 'K — Dưới 13 tuổi xem cùng cha mẹ',
  [AgeRating.T13]: 'T13 — Từ 13 tuổi',
  [AgeRating.T16]: 'T16 — Từ 16 tuổi',
  [AgeRating.T18]: 'T18 — Từ 18 tuổi',
  [AgeRating.C]: 'C — Không được phổ biến',
};

/** `2026-11-14` → `14/11/2026`, without going through `Date` (no time zone shift). */
export function formatReleaseDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return year && month && day ? `${day}/${month}/${year}` : isoDate;
}

/** `128` → `2 giờ 8 phút`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} phút`;
  return rest === 0 ? `${hours} giờ` : `${hours} giờ ${rest} phút`;
}
