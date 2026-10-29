import { BookingStatus, VNPAY_SUCCESS_CODE } from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Loader2, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ErrorState } from '@/components/catalog/query-states';
import { BookingStepper } from '@/components/booking/booking-stepper';
import { Button } from '@/components/ui/button';
import { bookingKeys, getBooking } from '@/features/bookings/bookings-api';
import { checkVnpayReturn, paymentKeys } from '@/features/payments/payments-api';

/** How often the booking is read again while the payment waits for the IPN. */
const POLL_INTERVAL_MS = 3_000;
/** After this long without a final status, stop polling and send the customer to the booking. */
const POLL_LIMIT_MS = 2 * 60_000;

const FINAL_STATUSES = new Set<BookingStatus>([
  BookingStatus.CONFIRMED,
  BookingStatus.NEEDS_REVIEW,
  BookingStatus.EXPIRED,
]);

function Panel({
  icon,
  title,
  children,
  testId,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-surface px-6 py-12 text-center"
    >
      {icon}
      <div className="space-y-2">
        <h2 className="text-xl font-bold text-cream">{title}</h2>
        {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

function BookingLink({
  bookingId,
  label = 'Xem đơn của bạn',
}: {
  bookingId: string;
  label?: string;
}) {
  return (
    <Button asChild className="h-11 rounded-xl px-6 font-semibold">
      <Link to={`/bookings/${bookingId}`}>{label}</Link>
    </Button>
  );
}

/**
 * VNPay said the payment went through: the booking only changes once the IPN reaches the API
 * (week 12), so it is read again every few seconds until it has a final status or the time limit.
 */
function AwaitingConfirmation({ bookingId }: { bookingId: string }) {
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const { data } = useQuery({
    queryKey: bookingKeys.detail(bookingId),
    queryFn: () => getBooking(bookingId),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.booking.status;
      return gaveUp || (status && FINAL_STATUSES.has(status)) ? false : POLL_INTERVAL_MS;
    },
  });
  const status = data?.booking.status;

  if (status === BookingStatus.CONFIRMED) {
    return (
      <Panel
        testId="payment-confirmed"
        icon={<CircleCheck className="size-10 text-brand" aria-hidden />}
        title="Thanh toán thành công"
      >
        <p>Vé của đơn {data?.booking.code} đã được phát hành.</p>
        <div className="mt-4">
          <BookingLink bookingId={bookingId} label="Xem vé" />
        </div>
      </Panel>
    );
  }
  if (status === BookingStatus.NEEDS_REVIEW) {
    return (
      <Panel
        testId="payment-needs-review"
        icon={<ShieldAlert className="size-10 text-brand" aria-hidden />}
        title="Đơn đang được xử lý"
      >
        <p>
          Chúng tôi đã nhận thanh toán nhưng không giữ được ghế của đơn. Bộ phận hỗ trợ sẽ liên hệ
          với bạn để hoàn tiền hoặc đổi ghế.
        </p>
        <div className="mt-4">
          <BookingLink bookingId={bookingId} />
        </div>
      </Panel>
    );
  }
  if (status === BookingStatus.EXPIRED) {
    return (
      <Panel
        testId="payment-booking-expired"
        icon={<CircleX className="size-10 text-muted-foreground" aria-hidden />}
        title="Đơn đã hết hạn"
      >
        <p>Đơn đã hết hạn trước khi thanh toán được xác nhận. Vui lòng kiểm tra lại đơn của bạn.</p>
        <div className="mt-4">
          <BookingLink bookingId={bookingId} />
        </div>
      </Panel>
    );
  }
  if (gaveUp) {
    return (
      <Panel
        testId="payment-still-pending"
        icon={<Loader2 className="size-10 text-muted-foreground" aria-hidden />}
        title="Đang chờ xác nhận thanh toán"
      >
        <p>
          VNPay đã báo giao dịch thành công nhưng hệ thống chưa nhận được xác nhận. Vui lòng kiểm
          tra lại đơn sau ít phút; bạn không cần thanh toán lại.
        </p>
        <div className="mt-4">
          <BookingLink bookingId={bookingId} />
        </div>
      </Panel>
    );
  }
  return (
    <Panel
      testId="payment-awaiting"
      icon={<Loader2 className="size-10 animate-spin text-brand" aria-hidden />}
      title="Đang xác nhận thanh toán…"
    >
      <p>VNPay đã báo giao dịch thành công. Vui lòng chờ trong giây lát, đừng đóng trang này.</p>
    </Panel>
  );
}

/**
 * `/payment/result` (ROADMAP 3.3): `vnp_ReturnUrl`. Passes the whole query VNPay appended to
 * `GET /payments/vnpay/return` and shows what it says. This page never decides a payment
 * succeeded: only the booking status, set by the IPN, does.
 */
export function PaymentResultPage() {
  const search = useLocation().search.replace(/^\?/, '');
  const { data, isPending, error, refetch } = useQuery({
    queryKey: paymentKeys.vnpayReturn(search),
    queryFn: () => checkVnpayReturn(search),
    retry: false,
    staleTime: Infinity,
  });

  let content: ReactNode;
  if (isPending) {
    content = (
      <div
        role="status"
        aria-label="Đang kiểm tra kết quả thanh toán"
        className="h-64 animate-pulse rounded-2xl bg-white/5"
      />
    );
  } else if (!data) {
    content = <ErrorState error={error} onRetry={() => void refetch()} />;
  } else if (!data.verified || data.amountMismatch) {
    content = (
      <Panel
        testId="payment-unverified"
        icon={<ShieldAlert className="size-10 text-destructive" aria-hidden />}
        title="Không xác thực được kết quả"
      >
        <p>Không xác thực được kết quả thanh toán. Vui lòng kiểm tra lại đơn của bạn.</p>
        {data.verified && (
          <div className="mt-4">
            <BookingLink bookingId={data.bookingId} />
          </div>
        )}
      </Panel>
    );
  } else if (data.vnpResponseCode !== VNPAY_SUCCESS_CODE) {
    content = (
      <Panel
        testId="payment-failed"
        icon={<CircleX className="size-10 text-destructive" aria-hidden />}
        title="Thanh toán không thành công"
      >
        <p>
          Giao dịch không thành công hoặc đã bị hủy
          {data.vnpResponseCode ? ` (mã VNPay ${data.vnpResponseCode})` : ''}. Bạn có thể thanh toán
          lại trước khi đơn hết hạn.
        </p>
        <div className="mt-4">
          <BookingLink bookingId={data.bookingId} label="Quay lại đơn" />
        </div>
      </Panel>
    );
  } else {
    content = <AwaitingConfirmation bookingId={data.bookingId} />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-extrabold text-cream">Kết quả thanh toán</h1>
      <BookingStepper current={2} />
      {content}
    </div>
  );
}
