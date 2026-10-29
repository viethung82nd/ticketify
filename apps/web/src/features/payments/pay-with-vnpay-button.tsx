import { PaymentErrorCode } from '@ticketify/shared';
import { useMutation } from '@tanstack/react-query';
import { CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiErrorOf } from '@/lib/api-error';
import { paymentErrorMessage } from './payment-errors';
import { createVnpayPayment } from './payments-api';

/** Codes after which the booking shown is out of date (expired, paid, no longer PENDING). */
const STALE_BOOKING_CODES = new Set<string>([
  PaymentErrorCode.BOOKING_EXPIRED,
  PaymentErrorCode.BOOKING_NOT_PAYABLE,
  PaymentErrorCode.BOOKING_ALREADY_PAID,
]);

/**
 * Starts a VNPay payment for a PENDING booking and sends the browser to VNPay. Every click is a new
 * attempt on the API side (a new txnRef), so the button stays disabled from the click until the
 * page has left.
 */
export function PayWithVnpayButton({
  bookingId,
  onStale,
}: {
  bookingId: string;
  /** The API says the booking changed: reload it. */
  onStale: () => void;
}) {
  const pay = useMutation({
    mutationFn: () => createVnpayPayment(bookingId),
    onSuccess: (payment) => window.location.assign(payment.paymentUrl),
    onError: (error) => {
      const code = apiErrorOf(error)?.code;
      if (code && STALE_BOOKING_CODES.has(code)) onStale();
    },
  });
  // Still busy after success: the browser is on its way to VNPay.
  const busy = pay.isPending || pay.isSuccess;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        onClick={() => pay.mutate()}
        disabled={busy}
        className="h-12 w-full rounded-xl text-base font-semibold"
        data-testid="pay-vnpay"
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <CreditCard aria-hidden />}
        {busy ? 'Đang chuyển sang VNPay…' : 'Thanh toán qua VNPay'}
      </Button>
      {pay.isError && (
        <p role="alert" className="text-sm text-destructive">
          {paymentErrorMessage(pay.error)}
        </p>
      )}
    </div>
  );
}
