import { PaymentErrorCode, PaymentProvider } from '@ticketify/shared';
import { useMutation } from '@tanstack/react-query';
import { CreditCard, Loader2, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { apiErrorOf } from '@/lib/api-error';
import { leaveTo } from '@/lib/navigation';
import { paymentErrorMessage } from './payment-errors';
import { createMomoPayment, createVnpayPayment } from './payments-api';

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
 * The payment methods of a PENDING booking: VNPay or the MoMo wallet. The click asks the API for
 * the gateway's page (the amount is the booking's, on the server) and sends the browser there.
 * From the click until the page has left, every button is disabled: one click, one gateway.
 * Paying is only ever confirmed by the gateway's server-to-server notification, never here.
 */
export function PaymentOptions({
  bookingId,
  onStale,
}: {
  bookingId: string;
  /** The API says the booking changed: reload it. */
  onStale: () => void;
}) {
  const pay = useMutation({
    mutationFn: async (gateway: Gateway) => gateway.start(bookingId),
    onSuccess: (url) => leaveTo(url),
    onError: (error) => {
      const code = apiErrorOf(error)?.code;
      if (code && STALE_BOOKING_CODES.has(code)) onStale();
    },
  });
  // Still busy after success: the browser is on its way to the gateway.
  const busy = pay.isPending || pay.isSuccess;
  const chosen = pay.variables?.provider;

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
              onClick={() => pay.mutate(gateway)}
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
      </div>
      {pay.isError && (
        <p role="alert" className="text-sm text-destructive">
          {paymentErrorMessage(pay.error)}
        </p>
      )}
    </div>
  );
}
