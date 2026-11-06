import { cinemaDateOf, cinemaTimeOf, NotificationType } from '@ticketify/shared';
import type {
  BookingNeedsReviewPayload,
  PaymentRefundRequiredPayload,
} from '../../infra/outbox/outbox-payloads';
import { ReviewReason } from '../payment/seat-settlement';
import type { DeliveryBooking } from './booking-delivery';

/**
 * Vietnamese wording of what the cinema sends out: notifications (ROADMAP 4.2) and, from 4.6, the
 * emails. Pure functions, so the copy can be read and tested without a database or a mailer.
 */

/** `19:30 ngày 05/11/2026` — how a showtime is written for a reader, in the cinema's time zone. */
export function cinemaMoment(instant: Date, timeZone: string): string {
  const [year, month, day] = cinemaDateOf(instant, timeZone).split('-');
  return `${cinemaTimeOf(instant, timeZone)} ngày ${day}/${month}/${year}`;
}

/** `150.000 đ` — amounts are whole dong (PLAN §3: no decimals in VND). */
export const money = (amount: number): string => `${amount.toLocaleString('vi-VN')} đ`;

/** What the user is told when a paid booking could not keep its seats. */
const REVIEW_REASON_TEXT: Readonly<Record<ReviewReason, string>> = {
  [ReviewReason.SHOWTIME_CANCELLED]: 'suất chiếu đã bị hủy',
  [ReviewReason.SHOWTIME_ENDED]: 'suất chiếu đã kết thúc',
  [ReviewReason.SEAT_SOLD]: 'có ghế đã được bán cho đơn khác',
  [ReviewReason.SEAT_HELD_BY_OTHER]: 'có ghế đang được đơn khác giữ',
  [ReviewReason.SEAT_RELEASED]: 'ghế đã được nhả trước khi tiền về',
  [ReviewReason.NO_SEATS]: 'đơn không còn ghế nào',
};

export const reviewReasonText = (reason: ReviewReason): string =>
  REVIEW_REASON_TEXT[reason] ?? 'có vấn đề với ghế của đơn';

/** Title, body and `data` of one notification, ready for `NotificationsService.store`. */
export interface NotificationText {
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, string | number | boolean>;
}

const where = (booking: DeliveryBooking, timeZone: string): string =>
  `${booking.movie.title}, suất ${cinemaMoment(booking.showtime.startsAt, timeZone)} ` +
  `tại ${booking.room.name}`;

const seatList = (booking: DeliveryBooking): string =>
  booking.seats.map((seat) => seat.label).join(', ');

/** To the user whose booking is paid and whose tickets exist. */
export function confirmedText(booking: DeliveryBooking, timeZone: string): NotificationText {
  return {
    type: NotificationType.BOOKING_CONFIRMED,
    title: `Đơn ${booking.code} đã được xác nhận`,
    body:
      `Vé của bạn cho ${where(booking, timeZone)} đã sẵn sàng. ` +
      `Ghế ${seatList(booking)}. Mời bạn xem vé trong mục đơn của tôi.`,
    data: {
      bookingId: booking.id,
      bookingCode: booking.code,
      showtimeId: booking.showtime.id,
      ticketCount: booking.tickets.length,
    },
  };
}

/** To the user who paid but gets no ticket: an apology, and what happens next. */
export function needsReviewUserText(
  booking: DeliveryBooking,
  payload: BookingNeedsReviewPayload,
  timeZone: string,
): NotificationText {
  return {
    type: NotificationType.BOOKING_NEEDS_REVIEW,
    title: `Đơn ${booking.code} cần được xem lại`,
    body:
      `Chúng tôi đã nhận ${money(payload.amount)} cho ${where(booking, timeZone)}, ` +
      `nhưng ${reviewReasonText(payload.reason)}, nên chưa thể phát hành vé. ` +
      'Nhân viên sẽ liên hệ và hoàn tiền cho bạn. Chúng tôi xin lỗi vì sự bất tiện này.',
    data: {
      bookingId: booking.id,
      bookingCode: booking.code,
      showtimeId: booking.showtime.id,
      reason: payload.reason,
    },
  };
}

/** To every admin: the same booking, said in the words of someone who has to fix it. */
export function needsReviewAdminText(
  booking: DeliveryBooking,
  payload: BookingNeedsReviewPayload,
  timeZone: string,
): NotificationText {
  return {
    type: NotificationType.BOOKING_NEEDS_REVIEW,
    title: `Cần xử lý tay: đơn ${booking.code} (${payload.reason})`,
    body:
      `${booking.user.fullName} (${booking.user.email}) đã trả ${money(payload.amount)} cho ` +
      `${where(booking, timeZone)} nhưng ${reviewReasonText(payload.reason)}. ` +
      `Mã giao dịch VNPay ${payload.vnpTransactionNo ?? 'không có'}. Hoàn tiền bằng tay.`,
    data: {
      bookingId: booking.id,
      bookingCode: booking.code,
      showtimeId: booking.showtime.id,
      paymentId: payload.paymentId,
      reason: payload.reason,
      amount: payload.amount,
    },
  };
}

/** To every admin: one booking was paid twice and the second payment must go back. */
export function refundRequiredAdminText(payload: PaymentRefundRequiredPayload): NotificationText {
  return {
    type: NotificationType.PAYMENT_REFUND_REQUIRED,
    title: `Cần hoàn tiền: đơn ${payload.bookingCode} được trả hai lần`,
    body:
      `Đơn ${payload.bookingCode} đã được thanh toán bởi một giao dịch khác, nên lần trả này ` +
      `(${money(payload.amount)}, mã giao dịch VNPay ${payload.vnpTransactionNo ?? 'không có'}, ` +
      `mã đơn hàng ${payload.txnRef}) phải được hoàn bằng tay. Đơn và vé không thay đổi.`,
    data: {
      bookingId: payload.bookingId,
      bookingCode: payload.bookingCode,
      paymentId: payload.paymentId,
      paidPaymentId: payload.paidPaymentId,
      amount: payload.amount,
    },
  };
}
