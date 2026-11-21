import { VoucherUsageStatus } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * What confirming a booking did to its voucher use (ROADMAP 5.2):
 * - `none`: the booking has no voucher;
 * - `consumed`: RESERVED → CONSUMED, the ordinary case — the count of uses does not change;
 * - `taken_back`: RELEASED → CONSUMED. The booking had EXPIRED, which gave the use back, and a
 *   late payment confirmed it again (3.7 branch B). The customer paid the discounted total, so the
 *   use is taken back without checking the limits again; it can put the voucher one use over
 *   `usageLimit` or `perUserLimit` (ROADMAP "Đã chốt", awaiting the owner's review).
 */
export type VoucherUseOnConfirm = 'none' | 'consumed' | 'taken_back';

/**
 * Booking CONFIRMED → its use CONSUMED, in the confirming transaction. Locks nothing but the
 * booking's own `voucher_usages` row (no hold ever updates one: a hold only inserts its new row
 * and counts), and never the voucher: CONSUMED takes no new use, so there is no limit to check.
 * The caller holds the booking row FOR UPDATE, which already serializes every flow that changes
 * this row (confirm, expiry, cancel).
 *
 * One statement: the self-join hands back the status the row had before the update.
 */
export async function consumeVoucherUse(
  tx: Tx,
  bookingId: string,
  now: Date,
): Promise<VoucherUseOnConfirm> {
  const [row] = await tx.$queryRaw<{ previous: VoucherUsageStatus }[]>`
    UPDATE voucher_usages u SET status = 'CONSUMED', updated_at = ${now}
    FROM voucher_usages old
    WHERE u.id = old.id AND u.booking_id = ${bookingId}::uuid AND u.status <> 'CONSUMED'
    RETURNING old.status::text AS previous`;
  if (!row) return 'none';
  return row.previous === VoucherUsageStatus.RELEASED ? 'taken_back' : 'consumed';
}

/**
 * Booking EXPIRED (expiry, cancel) or NEEDS_REVIEW → its RESERVED use RELEASED, in the same
 * transaction: the use goes back and the next hold's count no longer sees it. A RELEASED or
 * CONSUMED use is left alone (a second expiry, or a booking that never had a voucher, changes
 * nothing). Like `consumeVoucherUse`, it never locks the voucher: RELEASED only lowers the count.
 * Returns whether a use was released.
 */
export async function releaseVoucherUse(tx: Tx, bookingId: string, now: Date): Promise<boolean> {
  const released = await tx.$executeRaw`
    UPDATE voucher_usages SET status = 'RELEASED', updated_at = ${now}
    WHERE booking_id = ${bookingId}::uuid AND status = 'RESERVED'`;
  return released > 0;
}
