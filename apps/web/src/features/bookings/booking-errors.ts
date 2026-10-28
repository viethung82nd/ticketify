import { BookingErrorCode, CommonErrorCode } from '@ticketify/shared';
import { apiErrorOf, isNetworkError } from '@/lib/api-error';
import { retryAfterOf } from './bookings-api';

/**
 * Vietnamese message for a failed `POST /bookings` that is not a seat conflict (those name the
 * seats, see the booking page). Never a bare "something went wrong" for a known code.
 */
export function holdErrorMessage(error: unknown): string {
  if (isNetworkError(error)) {
    return 'Không kết nối được máy chủ. Bấm “Tiếp tục” để thử lại: ghế sẽ không bị giữ hai lần.';
  }
  const code = apiErrorOf(error)?.code;
  switch (code) {
    case BookingErrorCode.TOO_MANY_ATTEMPTS: {
      const seconds = retryAfterOf(error);
      return seconds
        ? `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${seconds} giây.`
        : 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.';
    }
    case BookingErrorCode.BOOKING_ALREADY_PENDING:
      return 'Bạn đang có một đơn chờ thanh toán cho suất này. Ghế của đơn đó vẫn được giữ đến hết thời gian chờ.';
    case BookingErrorCode.SHOWTIME_STARTED:
      return 'Suất chiếu đã bắt đầu, không thể đặt vé nữa.';
    case BookingErrorCode.SHOWTIME_CANCELLED:
      return 'Suất chiếu đã bị hủy.';
    case BookingErrorCode.COMBO_NOT_AVAILABLE:
      return 'Một số combo vừa ngừng bán và đã được bỏ khỏi đơn. Vui lòng kiểm tra lại rồi bấm “Tiếp tục”.';
    case BookingErrorCode.SEAT_NOT_FOUND:
    case BookingErrorCode.COUPLE_INCOMPLETE:
      return 'Sơ đồ ghế vừa thay đổi. Sơ đồ đã được tải lại, vui lòng chọn lại ghế.';
    case CommonErrorCode.DATABASE_BUSY:
      return 'Hệ thống đang bận. Vui lòng bấm “Tiếp tục” để thử lại.';
    case 'UNAUTHORIZED':
    case 'TOKEN_INVALID':
    case 'TOKEN_EXPIRED':
      return 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.';
    default:
      return 'Không giữ được ghế. Vui lòng thử lại.';
  }
}
