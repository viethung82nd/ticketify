import {
  BookingErrorCode,
  CommonErrorCode,
  formatVnd,
  voucherMinSubtotalDetailsSchema,
  VoucherErrorCode,
  voucherPeriodDetailsSchema,
} from '@ticketify/shared';
import { apiErrorOf, isNetworkError } from '@/lib/api-error';
import { cinemaDate, cinemaTime, longDayLabel } from '@/lib/cinema-time';
import { pendingBookingOf, retryAfterOf } from './bookings-api';

const vnd = (amount: number) => `${formatVnd(amount)} ₫`;
const moment = (iso: string) => `${cinemaTime(iso)} ${longDayLabel(cinemaDate(iso))}`;

/**
 * Vietnamese message for a `POST /bookings` refused because of its voucher alone (ROADMAP 5.2),
 * shown under the voucher field: the seats are not the problem and stay chosen. `undefined` for
 * any other error. Nothing was held, so removing the code and continuing always works.
 */
export function voucherErrorMessage(error: unknown): string | undefined {
  const apiError = apiErrorOf(error);
  switch (apiError?.code) {
    case VoucherErrorCode.VOUCHER_NOT_AVAILABLE:
      return 'Mã giảm giá không tồn tại hoặc đã ngừng áp dụng.';
    case VoucherErrorCode.VOUCHER_NOT_IN_EFFECT: {
      const period = voucherPeriodDetailsSchema.safeParse(apiError.details);
      return period.success
        ? `Mã giảm giá chỉ áp dụng từ ${moment(period.data.startsAt)} đến trước ${moment(period.data.endsAt)}.`
        : 'Mã giảm giá chưa đến hoặc đã hết thời gian áp dụng.';
    }
    case VoucherErrorCode.VOUCHER_MIN_SUBTOTAL_NOT_MET: {
      const min = voucherMinSubtotalDetailsSchema.safeParse(apiError.details);
      return min.success
        ? `Mã giảm giá áp dụng cho đơn từ ${vnd(min.data.minSubtotal)} (đơn này ${vnd(min.data.subtotal)}). Chọn thêm ghế hoặc combo, hoặc bỏ mã.`
        : 'Đơn chưa đạt giá trị tối thiểu của mã giảm giá.';
    }
    case VoucherErrorCode.VOUCHER_USAGE_LIMIT_REACHED:
      return 'Mã giảm giá đã hết lượt sử dụng. Bạn có thể bỏ mã để tiếp tục đặt vé.';
    case VoucherErrorCode.VOUCHER_USER_LIMIT_REACHED:
      return 'Bạn đã dùng hết số lượt của mã này, kể cả các đơn đang chờ thanh toán.';
    default:
      return undefined;
  }
}

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
    case BookingErrorCode.BOOKING_ALREADY_PENDING: {
      const pending = pendingBookingOf(error);
      return pending
        ? `Bạn đang có một đơn chờ thanh toán cho suất này (hạn thanh toán ${cinemaTime(pending.expiresAt)}). Hãy hoàn tất đơn đó, hoặc đặt lại sau khi đơn hết hạn.`
        : 'Bạn đang có một đơn chờ thanh toán cho suất này. Hãy hoàn tất đơn đó, hoặc đặt lại sau khi đơn hết hạn.';
    }
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
      return voucherErrorMessage(error) ?? 'Không giữ được ghế. Vui lòng thử lại.';
  }
}
