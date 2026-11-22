import { CommonErrorCode, PaymentErrorCode } from '@ticketify/shared';
import { retryAfterOf } from '@/features/bookings/bookings-api';
import { apiErrorOf, isNetworkError } from '@/lib/api-error';

/** Vietnamese message for a failed `POST /payments/vnpay` or `POST /payments/momo`. */
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
      return 'Phương thức thanh toán này đang tạm ngưng. Vui lòng chọn cách khác hoặc thử lại sau.';
    case PaymentErrorCode.PAYMENT_AMOUNT_NOT_SUPPORTED:
      return 'Số tiền của đơn nằm ngoài hạn mức của ví MoMo. Vui lòng chọn VNPay.';
    case PaymentErrorCode.PAYMENT_PROVIDER_ERROR:
      return 'Cổng thanh toán từ chối tạo giao dịch. Vui lòng thử lại hoặc chọn cách khác.';
    case PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE:
      return 'Cổng thanh toán chưa phản hồi. Vui lòng bấm thử lại sau giây lát; bạn sẽ không bị tạo thêm giao dịch.';
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
