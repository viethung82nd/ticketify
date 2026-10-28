import {
  CatalogErrorCode,
  ComboErrorCode,
  fieldErrorSchema,
  PricingErrorCode,
  RoomErrorCode,
  ShowtimeErrorCode,
} from '@ticketify/shared';
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
  // Rooms & seat layout (admin).
  [RoomErrorCode.ROOM_NOT_FOUND]: 'Không tìm thấy phòng. Có thể phòng đã bị xóa.',
  [RoomErrorCode.ROOM_NAME_TAKEN]: 'Tên phòng này đã được dùng.',
  [RoomErrorCode.ROOM_HAS_SHOWTIMES]:
    'Phòng đã có suất chiếu (kể cả suất đã qua hoặc đã hủy) nên không thể xóa.',
  [RoomErrorCode.ROOM_IN_USE]:
    'Phòng đang có suất chiếu chưa kết thúc nên sơ đồ ghế bị khóa. Bạn vẫn có thể đổi tên phòng.',
  [RoomErrorCode.SEAT_NOT_FOUND]:
    'Sơ đồ ghế đã thay đổi ở nơi khác. Hãy hủy thay đổi để tải lại rồi thử lại.',
  [RoomErrorCode.INVALID_CHANGES]:
    'Một ghế xuất hiện nhiều lần trong cùng một lần lưu. Hãy hủy thay đổi rồi thử lại.',
  [RoomErrorCode.INVALID_COUPLE]: 'Ghế đôi chưa hợp lệ. Xem danh sách lỗi bên dưới.',
  [RoomErrorCode.COUPLE_INCONSISTENT]:
    'Hai ghế của một cặp ghế đôi phải cùng bật hoặc cùng tắt. Xem danh sách lỗi bên dưới.',
  // Prices & holidays (admin).
  [PricingErrorCode.PRICE_NOT_FOUND]: 'Không tìm thấy ô giá này. Hãy chạy lại seed dữ liệu giá.',
  [PricingErrorCode.HOLIDAY_EXISTS]: 'Ngày này đã có trong danh sách ngày lễ.',
  [PricingErrorCode.HOLIDAY_NOT_FOUND]: 'Không tìm thấy ngày lễ. Có thể đã bị xóa.',
  // Showtimes (admin and public).
  [ShowtimeErrorCode.SHOWTIME_NOT_FOUND]: 'Không tìm thấy suất chiếu. Có thể suất đã bị hủy.',
  [ShowtimeErrorCode.SHOWTIME_OVERLAP]: 'Phòng đã có suất chiếu khác trong khoảng giờ này.',
  [ShowtimeErrorCode.SHOWTIME_STARTED]: 'Suất chiếu đã bắt đầu nên không thể hủy.',
  [ShowtimeErrorCode.SHOWTIME_HAS_BOOKINGS]:
    'Suất chiếu đã có ghế đang được giữ hoặc đã bán. Hệ thống không hoàn tiền nên không thể hủy suất này.',
  [ShowtimeErrorCode.MOVIE_ENDED]: 'Phim đã kết thúc nên không thể xếp suất chiếu mới.',
  // Combos (admin).
  [ComboErrorCode.COMBO_NOT_FOUND]: 'Không tìm thấy combo. Có thể combo đã bị xóa.',
  [ComboErrorCode.COMBO_NAME_TAKEN]:
    'Đã có combo cùng tên (không phân biệt chữ hoa, chữ thường và dấu).',
  [ComboErrorCode.COMBO_IN_USE]:
    'Combo đã có trong đơn đặt vé nên không thể xóa. Hãy tắt combo để ẩn khỏi khách hàng.',
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
