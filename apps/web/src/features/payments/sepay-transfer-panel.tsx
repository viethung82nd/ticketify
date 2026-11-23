import { type CreatedSepayPayment, formatVnd } from '@ticketify/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { bookingKeys, getBooking } from '@/features/bookings/bookings-api';
import { formatCountdown, useCountdown } from '@/features/bookings/use-countdown';

/** How often the booking is read again while the transfer waits for SePay's webhook. */
export const SEPAY_POLL_INTERVAL_MS = 3_000;

function CopyValue({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // No clipboard (permission, old browser): the value stays on screen to copy by hand.
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2">
        <span className="font-semibold text-cream tabular-nums" data-testid={testId}>
          {value}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => void copy()}
          aria-label={`Sao chép ${label.toLowerCase()}`}
        >
          {copied ? (
            <Check className="size-4 text-brand" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
        </Button>
      </dd>
    </div>
  );
}

/**
 * What the customer transfers, and where: the VietQR, the bank account, the exact amount and the
 * exact content, with the time left. While it is shown, the booking is read again every few
 * seconds (sharing the page's query, so the page itself switches to "Đã xác nhận" or "Đã hết hạn"
 * and this panel goes away). Nothing here can mark the payment paid: only SePay's webhook,
 * checked on the server, confirms the booking.
 */
export function SepayTransferPanel({
  payment,
  bookingId,
  serverOffsetMs,
  onBack,
}: {
  payment: CreatedSepayPayment;
  bookingId: string;
  serverOffsetMs: number;
  /** Back to the list of payment methods. */
  onBack: () => void;
}) {
  useQuery({
    queryKey: bookingKeys.detail(bookingId),
    queryFn: () => getBooking(bookingId),
    refetchInterval: SEPAY_POLL_INTERVAL_MS,
    staleTime: 0,
  });
  const remaining = useCountdown(payment.expiresAt, serverOffsetMs);
  const amount = `${formatVnd(payment.amount)} ₫`;

  return (
    <section aria-labelledby="sepay-title" className="space-y-4" data-testid="sepay-panel">
      <h3 id="sepay-title" className="text-base font-semibold text-cream">
        Chuyển khoản ngân hàng (VietQR)
      </h3>
      <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
        <img
          src={payment.qrCodeUrl}
          alt={`Mã VietQR chuyển ${amount} tới tài khoản ${payment.accountNumber}, nội dung ${payment.transferContent}`}
          width={220}
          height={220}
          className="mx-auto size-[220px] rounded-xl bg-white p-2"
          data-testid="sepay-qr"
        />
        <dl className="divide-y divide-white/10">
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-sm text-muted-foreground">Ngân hàng</dt>
            <dd className="font-semibold text-cream">{payment.bankCode}</dd>
          </div>
          <CopyValue label="Số tài khoản" value={payment.accountNumber} testId="sepay-account" />
          {payment.accountHolder && (
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-sm text-muted-foreground">Chủ tài khoản</dt>
              <dd className="font-semibold text-cream">{payment.accountHolder}</dd>
            </div>
          )}
          <CopyValue label="Số tiền" value={amount} testId="sepay-amount" />
          <CopyValue label="Nội dung" value={payment.transferContent} testId="sepay-content" />
        </dl>
      </div>

      <p className="flex gap-2 rounded-xl border border-brand/40 bg-brand/10 px-4 py-2.5 text-sm text-cream">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
        Chuyển đúng số tiền {amount} với nội dung {payment.transferContent}. Sai số tiền hoặc nội
        dung sẽ không được xác nhận tự động.
      </p>

      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-between gap-3 rounded-xl border border-white/10 px-4 py-3"
      >
        <span className="flex items-center gap-2 text-sm text-cream">
          <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
          Đang chờ ngân hàng báo nhận tiền… Trang sẽ tự cập nhật.
        </span>
        <span
          className="font-semibold text-brand tabular-nums"
          data-testid="sepay-countdown"
          aria-label="Thời gian còn lại để chuyển khoản"
        >
          {formatCountdown(remaining)}
        </span>
      </div>

      <div className="space-y-1.5">
        <Button type="button" variant="outline" className="rounded-xl" onClick={onBack}>
          Chọn phương thức khác
        </Button>
        <p className="text-xs text-muted-foreground">
          Nếu bạn đã chuyển khoản, đừng thanh toán thêm bằng cách khác: khoản trả thừa phải chờ hoàn
          tiền thủ công.
        </p>
      </div>
    </section>
  );
}
