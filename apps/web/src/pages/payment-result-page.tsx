import {
  BookingStatus,
  MOMO_PENDING_RESULT_CODES,
  MOMO_SUCCESS_CODE,
  PaymentProvider,
  VNPAY_SUCCESS_CODE,
} from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ErrorState } from '@/components/catalog/query-states';
import { BookingStepper } from '@/components/booking/booking-stepper';
import { Button } from '@/components/ui/button';
import { bookingKeys, getBooking } from '@/features/bookings/bookings-api';
import { checkMomoReturn, checkVnpayReturn, paymentKeys } from '@/features/payments/payments-api';

/** How often the booking is read again while the payment waits for the IPN. */
const POLL_INTERVAL_MS = 3_000;
/** After this long without a final status, stop polling and let the customer check by hand. */
const POLL_LIMIT_MS = 2 * 60_000;

const FINAL_STATUSES = new Set<BookingStatus>([
  BookingStatus.CONFIRMED,
  BookingStatus.NEEDS_REVIEW,
  BookingStatus.EXPIRED,
]);

const GATEWAY_NAMES: Record<PaymentProvider, string> = {
  [PaymentProvider.VNPAY]: 'VNPay',
  [PaymentProvider.MOMO]: 'MoMo',
};

/**
 * What a gateway's redirect says, once the API checked its signature. Display only: whatever it
 * says, the booking only changes when the gateway's IPN reaches the API.
 */
type ReturnCheck =
  | { verified: false }
  | {
      verified: true;
      bookingId: string;
      amountMismatch: boolean;
      /** `paid`: the gateway reports success; `pending`: not final yet; `failed`: anything else. */
      reported: 'paid' | 'pending' | 'failed';
      /** The gateway's own result code, for the customer to quote. */
      code: string | null;
    };

async function checkReturn(provider: PaymentProvider, search: string): Promise<ReturnCheck> {
  if (provider === PaymentProvider.MOMO) {
    const result = await checkMomoReturn(search);
    if (!result.verified) return result;
    const { resultCode } = result;
    return {
      verified: true,
      bookingId: result.bookingId,
      amountMismatch: result.amountMismatch,
      reported:
        resultCode === MOMO_SUCCESS_CODE
          ? 'paid'
          : resultCode !== null && MOMO_PENDING_RESULT_CODES.includes(resultCode)
            ? 'pending'
            : 'failed',
      code: resultCode === null ? null : String(resultCode),
    };
  }
  const result = await checkVnpayReturn(search);
  if (!result.verified) return result;
  return {
    verified: true,
    bookingId: result.bookingId,
    amountMismatch: result.amountMismatch,
    reported: result.vnpResponseCode === VNPAY_SUCCESS_CODE ? 'paid' : 'failed',
    code: result.vnpResponseCode,
  };
}

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
 * The gateway said the payment went through (or is still being processed): the booking only
 * changes once the IPN reaches the API, so it is read again every few seconds until it has a final
 * status or the time limit; then the customer can check again by hand.
 */
function AwaitingConfirmation({ bookingId, gateway }: { bookingId: string; gateway: string }) {
  const [round, setRound] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [round]);
  const { data, refetch, isFetching } = useQuery({
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
          {gateway} đã báo giao dịch nhưng hệ thống chưa nhận được xác nhận. Vui lòng kiểm tra lại
          sau ít phút; bạn không cần thanh toán lại.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-xl px-6 font-semibold"
            disabled={isFetching}
            onClick={() => {
              setGaveUp(false);
              setRound((n) => n + 1);
              void refetch();
            }}
            data-testid="payment-recheck"
          >
            <RefreshCw className={isFetching ? 'animate-spin' : undefined} aria-hidden />
            Kiểm tra lại
          </Button>
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
      <p>
        {gateway} đã báo giao dịch. Vui lòng chờ trong giây lát, đừng đóng trang này; vé chỉ được
        phát hành khi hệ thống nhận được xác nhận từ {gateway}.
      </p>
    </Panel>
  );
}

/**
 * `/payment/result` (VNPay, ROADMAP 3.3: `vnp_ReturnUrl`) and `/payment/result/momo` (MoMo:
 * `redirectUrl`). Passes the whole query the gateway appended to the API's return check and shows
 * what it says. This page never decides a payment succeeded: only the booking status, set by the
 * gateway's IPN, does. Query parameters are never read here for anything but passing them on.
 */
export function PaymentResultPage({
  provider = PaymentProvider.VNPAY,
}: {
  provider?: PaymentProvider;
}) {
  const gateway = GATEWAY_NAMES[provider];
  const search = useLocation().search.replace(/^\?/, '');
  const { data, isPending, error, refetch } = useQuery({
    queryKey:
      provider === PaymentProvider.MOMO
        ? paymentKeys.momoReturn(search)
        : paymentKeys.vnpayReturn(search),
    queryFn: () => checkReturn(provider, search),
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
  } else if (data.reported === 'failed') {
    content = (
      <Panel
        testId="payment-failed"
        icon={<CircleX className="size-10 text-destructive" aria-hidden />}
        title="Thanh toán không thành công"
      >
        <p>
          Giao dịch không thành công hoặc đã bị hủy
          {data.code ? ` (mã ${gateway} ${data.code})` : ''}. Bạn có thể thanh toán lại trước khi
          đơn hết hạn.
        </p>
        <div className="mt-4">
          <BookingLink bookingId={data.bookingId} label="Quay lại đơn" />
        </div>
      </Panel>
    );
  } else {
    content = <AwaitingConfirmation bookingId={data.bookingId} gateway={gateway} />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-extrabold text-cream">Kết quả thanh toán</h1>
      <BookingStepper current={2} />
      {content}
    </div>
  );
}
