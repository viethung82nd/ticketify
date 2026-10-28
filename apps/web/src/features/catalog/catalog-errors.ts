import { CatalogErrorCode, fieldErrorSchema } from '@ticketify/shared';
import { z } from 'zod';
import { apiErrorOf, isNetworkError } from '@/lib/api-error';

const MESSAGES: Record<string, string> = {
  [CatalogErrorCode.MOVIE_NOT_FOUND]: 'Không tìm thấy phim. Có thể phim đã bị xóa.',
  [CatalogErrorCode.GENRE_NOT_FOUND]: 'Không tìm thấy thể loại. Có thể thể loại đã bị xóa.',
  [CatalogErrorCode.INVALID_GENRES]: 'Có thể loại không còn tồn tại. Vui lòng chọn lại.',
  [CatalogErrorCode.SLUG_TAKEN]: 'Slug này đã được phim khác sử dụng.',
  [CatalogErrorCode.GENRE_NAME_TAKEN]: 'Thể loại này đã tồn tại.',
  [CatalogErrorCode.MOVIE_HAS_SHOWTIMES]:
    'Phim đã có suất chiếu nên không thể xóa. Hãy chuyển trạng thái sang “Đã kết thúc”.',
  [CatalogErrorCode.GENRE_IN_USE]:
    'Thể loại đang được gắn cho phim nên không thể xóa. Hãy bỏ thể loại khỏi các phim trước.',
  [CatalogErrorCode.POSTER_NOT_UPLOADED]: 'Poster chưa được tải lên xong. Vui lòng tải lại ảnh.',
  [CatalogErrorCode.STORAGE_UNAVAILABLE]:
    'Kho lưu trữ ảnh đang tạm thời gián đoạn. Vui lòng thử lại sau.',
  FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
  UNAUTHORIZED: 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại các trường được đánh dấu.',
};

/** Vietnamese message for a catalog API failure, based on its error `code`. */
export function catalogErrorMessage(error: unknown): string {
  if (isNetworkError(error)) return 'Không kết nối được máy chủ. Vui lòng thử lại sau.';
  const code = apiErrorOf(error)?.code;
  return (code && MESSAGES[code]) ?? 'Đã có lỗi xảy ra. Vui lòng thử lại.';
}

export const errorCodeOf = (error: unknown): string | undefined => apiErrorOf(error)?.code;

/** Fields named by the API: `VALIDATION_FAILED` details, or `details.field` of other errors. */
export function errorFieldsOf(error: unknown): string[] {
  const details = apiErrorOf(error)?.details;
  const list = z.array(fieldErrorSchema).safeParse(details);
  if (list.success) return list.data.map((item) => item.field);
  const single = z.object({ field: z.string() }).safeParse(details);
  return single.success ? [single.data.field] : [];
}
