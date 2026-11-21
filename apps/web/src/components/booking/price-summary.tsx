import { formatVnd } from '@ticketify/shared';
import type { ReactNode } from 'react';

const vnd = (amount: number) => `${formatVnd(amount)} ₫`;

export interface PriceLine {
  key: string;
  label: ReactNode;
  amount: number;
}

export interface PriceSummaryProps {
  /** One line per seat or per group of seats, then one per combo. */
  lines: PriceLine[];
  /** Seats + combos (the API's `subtotal`, or the page's own sum before the hold). */
  subtotal: number;
  /**
   * The voucher: `discount` is what the API took off, or `null` before the hold, when only the API
   * can compute it (the page never guesses a discount). `null` voucher: no row at all.
   */
  voucher: { code: string; discount: number | null } | null;
  /** What the customer pays: `subtotal − discount`, or the subtotal while the discount is unknown. */
  total: number;
  /** Label of the total row; the subtotal row above it, shown with a voucher, is "Tạm tính". */
  totalLabel: string;
  totalTestId: string;
  /** Small print under the total. */
  note?: ReactNode;
}

function Row({
  label,
  children,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex justify-between gap-4 text-sm" data-testid={testId}>
      <dt className="min-w-0 break-words text-muted-foreground">{label}</dt>
      <dd className="shrink-0 text-right whitespace-nowrap text-cream tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * The price of a booking line by line (ROADMAP 5.4): each seat or seat group, each combo, the
 * subtotal, the voucher discount, the total. The same table on the booking page (before the hold,
 * the page's own sum) and the booking detail page (the API's figures).
 */
export function PriceSummary({
  lines,
  subtotal,
  voucher,
  total,
  totalLabel,
  totalTestId,
  note,
}: PriceSummaryProps) {
  return (
    <div className="space-y-4">
      <dl className="space-y-2" aria-label="Chi tiết giá">
        {lines.map((line) => (
          <Row key={line.key} label={line.label}>
            {vnd(line.amount)}
          </Row>
        ))}
      </dl>
      <dl className="space-y-2 border-t border-white/10 pt-4">
        {voucher && (
          <>
            <Row label="Tạm tính" testId="price-subtotal">
              {vnd(subtotal)}
            </Row>
            <Row
              label={
                <>
                  Giảm giá <span className="font-semibold text-cream">{voucher.code}</span>
                </>
              }
              testId="price-discount"
            >
              {voucher.discount === null ? (
                <span className="text-muted-foreground">Tính khi giữ ghế</span>
              ) : (
                `−${vnd(voucher.discount)}`
              )}
            </Row>
          </>
        )}
        <div className="flex justify-between pt-1 text-base font-bold text-cream">
          <dt>{totalLabel}</dt>
          <dd className="text-brand tabular-nums" data-testid={totalTestId}>
            {vnd(total)}
          </dd>
        </div>
      </dl>
      {/* Outside the <dl>: a list of terms may hold nothing but <dt>/<dd> groups. */}
      {note && <p className="-mt-2 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
