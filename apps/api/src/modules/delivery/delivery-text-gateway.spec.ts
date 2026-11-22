import {
  bookingNeedsReviewPayloadSchema,
  paymentRefundRequiredPayloadSchema,
} from '../../infra/outbox/outbox-payloads';
import { refundRequiredAdminText } from './delivery-text';

const ids = {
  paymentId: '01a17e75-7100-7679-b8b1-0000000000f1',
  bookingId: '01a17e75-7100-7679-b8b1-000000000001',
  userId: '01a17e75-7100-7679-b8b1-0000000000e1',
  paidPaymentId: '01a17e75-7100-7679-b8b1-0000000000f2',
};

/** The admin is told which merchant portal to refund in, with that gateway's transaction id. */
describe('admin refund text names the gateway (MoMo, 11/2026)', () => {
  it('a MoMo payment: "mã giao dịch MoMo <transId>"', () => {
    const payload = paymentRefundRequiredPayloadSchema.parse({
      ...ids,
      txnRef: 'Bq2qmIzmEDBQ2nWyKR55',
      bookingCode: 'K7PX3MQ9TA',
      amount: 180_000,
      provider: 'MOMO',
      vnpTransactionNo: null,
      providerTransactionId: '4088878653',
    });

    expect(refundRequiredAdminText(payload).body).toContain('mã giao dịch MoMo 4088878653');
  });

  it('an event written before MoMo (no provider): read as VNPay, with vnpTransactionNo', () => {
    const payload = paymentRefundRequiredPayloadSchema.parse({
      ...ids,
      txnRef: 'Bq2qmIzmEDBQ2nWyKR55',
      bookingCode: 'K7PX3MQ9TA',
      amount: 180_000,
      vnpTransactionNo: '14226112',
    });

    expect(payload.provider).toBe('VNPAY');
    expect(refundRequiredAdminText(payload).body).toContain('mã giao dịch VNPay 14226112');
  });

  it('a needs_review event from before MoMo still parses (provider defaults to VNPay)', () => {
    const payload = bookingNeedsReviewPayloadSchema.parse({
      bookingId: ids.bookingId,
      bookingCode: 'K7PX3MQ9TA',
      userId: ids.userId,
      showtimeId: '01a17e75-7100-7679-b8b1-0000000000a1',
      paymentId: ids.paymentId,
      amount: 180_000,
      vnpTransactionNo: '14226112',
      reason: 'SEAT_SOLD',
      seatIds: [],
      releasedSeatIds: [],
    });

    expect(payload).toMatchObject({ provider: 'VNPAY', vnpTransactionNo: '14226112' });
  });
});
