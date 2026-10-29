import { CommonErrorCode, PaymentErrorCode } from '@ticketify/shared';
import { retryAfterOf } from '@/features/bookings/bookings-api';
import { apiErrorOf, isNetworkError } from '@/lib/api-error';

/** Vietnamese message for a failed `POST /payments/vnpay`. */
export function paymentErrorMessage(error: unknown): string {
  if (isNetworkError(error)) {
    return 'Không kết nối được máy chủ. Vui lòng thử lại.';
  }
  switch (apiErrorOf(error)?.code) {
    case PaymentErrorCode.BOOKING_EXPIRED:
      return 'Đã hết thời gian thanh toán cho đơn này.';
    case PaymentErrorCode.BOOKING_NOT_PAYABLE:
      return 'Đơn này không còn ở trạng thái chờ thanh toán.';
    case PaymentErrorCode.BOOKING_ALREADY_PAID:
      return 'Đơn này đã được thanh toán.';
    case PaymentErrorCode.BOOKING_NOT_FOUND:
      return 'Không tìm thấy đơn.';
    case PaymentErrorCode.PAYMENT_NOT_CONFIGURED:
      return 'Thanh toán trực tuyến đang tạm ngưng. Vui lòng thử lại sau.';
    case PaymentErrorCode.TOO_MANY_ATTEMPTS: {
      const seconds = retryAfterOf(error);
      return seconds
        ? `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${seconds} giây.`
        : 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.';
    }
    case CommonErrorCode.DATABASE_BUSY:
      return 'Hệ thống đang bận. Vui lòng thử lại.';
    default:
      return 'Không tạo được thanh toán. Vui lòng thử lại.';
  }
}
