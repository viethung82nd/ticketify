import { PaymentErrorCode, PaymentProvider } from '@ticketify/shared';
import { useMutation } from '@tanstack/react-query';
import { CreditCard, Landmark, Loader2, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { apiErrorOf } from '@/lib/api-error';
import { leaveTo } from '@/lib/navigation';
import { paymentErrorMessage } from './payment-errors';
import { createMomoPayment, createSepayPayment, createVnpayPayment } from './payments-api';
import { SepayTransferPanel } from './sepay-transfer-panel';

/** Codes after which the booking shown is out of date (expired, paid, no longer PENDING). */
const STALE_BOOKING_CODES = new Set<string>([
  PaymentErrorCode.BOOKING_EXPIRED,
  PaymentErrorCode.BOOKING_NOT_PAYABLE,
  PaymentErrorCode.BOOKING_ALREADY_PAID,
]);

interface Gateway {
  provider: PaymentProvider;
  label: string;
  busyLabel: string;
  icon: ReactNode;
  testId: string;
  /** Starts (or resumes) the payment and gives the page to send the browser to. */
  start: (bookingId: string) => Promise<string>;
}

const GATEWAYS: readonly Gateway[] = [
  {
    provider: PaymentProvider.VNPAY,
    label: 'Thanh toán qua VNPay',
    busyLabel: 'Đang chuyển sang VNPay…',
    icon: <CreditCard aria-hidden />,
    testId: 'pay-vnpay',
    start: async (bookingId) => (await createVnpayPayment(bookingId)).paymentUrl,
  },
  {
    provider: PaymentProvider.MOMO,
    label: 'Thanh toán qua ví MoMo',
    busyLabel: 'Đang chuyển sang MoMo…',
    icon: <Wallet aria-hidden />,
    testId: 'pay-momo',
    start: async (bookingId) => (await createMomoPayment(bookingId)).payUrl,
  },
];

/**
 * The payment methods of a PENDING booking: VNPay, the MoMo wallet, or a bank transfer through
 * SePay. VNPay and MoMo: the click asks the API for the gateway's page (the amount is the
 * booking's, on the server) and sends the browser there. SePay: the click asks the API for the
 * transfer details and shows them here (QR, amount, content), waiting for the booking to change.
 * From the click until the answer, every button is disabled: one click, one request (the API
 * also hands an open attempt back instead of opening a second one). Paying is only ever
 * confirmed by the gateway's server-to-server notification, never here.
 */
export function PaymentOptions({
  bookingId,
  onStale,
  serverOffsetMs = 0,
}: {
  bookingId: string;
  /** The API says the booking changed: reload it. */
  onStale: () => void;
  /** Server clock − local clock, for the transfer countdown. */
  serverOffsetMs?: number;
}) {
  const onError = (error: unknown) => {
    const code = apiErrorOf(error)?.code;
    if (code && STALE_BOOKING_CODES.has(code)) onStale();
  };
  const pay = useMutation({
    mutationFn: async (gateway: Gateway) => gateway.start(bookingId),
    onSuccess: (url) => leaveTo(url),
    onError,
  });
  const transfer = useMutation({
    mutationFn: () => createSepayPayment(bookingId),
    onError,
  });
  // Still busy after success: the browser is on its way to the gateway.
  const busy = pay.isPending || pay.isSuccess || transfer.isPending;
  const chosen = transfer.isPending ? PaymentProvider.SEPAY : pay.variables?.provider;

  if (transfer.data) {
    return (
      <SepayTransferPanel
        payment={transfer.data}
        bookingId={bookingId}
        serverOffsetMs={serverOffsetMs}
        onBack={() => transfer.reset()}
      />
    );
  }
  const sepayLoading = busy && chosen === PaymentProvider.SEPAY;
  const failure = pay.isError ? pay.error : transfer.isError ? transfer.error : null;

  return (
    <div className="space-y-3">
      <p id="payment-methods-label" className="text-sm font-semibold text-cream">
        Chọn phương thức thanh toán
      </p>
      <div
        role="group"
        aria-labelledby="payment-methods-label"
        className="grid gap-3 sm:grid-cols-2"
      >
        {GATEWAYS.map((gateway) => {
          const loading = busy && chosen === gateway.provider;
          return (
            <Button
              key={gateway.provider}
              type="button"
              variant={gateway.provider === PaymentProvider.VNPAY ? 'default' : 'outline'}
              onClick={() => {
                transfer.reset();
                pay.mutate(gateway);
              }}
              disabled={busy}
              aria-busy={loading}
              className="h-12 w-full rounded-xl text-base font-semibold"
              data-testid={gateway.testId}
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : gateway.icon}
              {loading ? gateway.busyLabel : gateway.label}
            </Button>
          );
        })}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            pay.reset();
            transfer.mutate();
          }}
          disabled={busy}
          aria-busy={sepayLoading}
          className="h-12 w-full rounded-xl text-base font-semibold sm:col-span-2"
          data-testid="pay-sepay"
        >
          {sepayLoading ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Landmark aria-hidden />
          )}
          {sepayLoading ? 'Đang tạo mã chuyển khoản…' : 'Chuyển khoản ngân hàng (VietQR)'}
        </Button>
      </div>
      {failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          {paymentErrorMessage(failure)}
        </p>
      )}
    </div>
  );
}
