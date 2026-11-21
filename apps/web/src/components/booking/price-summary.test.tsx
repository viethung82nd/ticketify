import { VoucherErrorCode } from '@ticketify/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { voucherErrorMessage } from '@/features/bookings/booking-errors';
import { apiError } from '@/test/api-error';
import { PriceSummary } from './price-summary';

const LINES = [
  { key: 'a1', label: 'Ghế A1 · Thường', amount: 90_000 },
  { key: 'pop', label: 'Bắp lớn × 2', amount: 158_000 },
];

describe('PriceSummary', () => {
  it('without a voucher: the lines and the total, no subtotal or discount row', () => {
    render(
      <PriceSummary
        lines={LINES}
        subtotal={248_000}
        voucher={null}
        total={248_000}
        totalLabel="Tổng cộng"
        totalTestId="total"
      />,
    );

    expect(screen.getByText('Bắp lớn × 2')).toBeInTheDocument();
    expect(screen.getByTestId('total')).toHaveTextContent('248.000 ₫');
    expect(screen.queryByTestId('price-subtotal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('price-discount')).not.toBeInTheDocument();
  });

  it('before the hold: the code with "Tính khi giữ ghế", never a guessed discount', () => {
    render(
      <PriceSummary
        lines={LINES}
        subtotal={248_000}
        voucher={{ code: 'GIAM20', discount: null }}
        total={248_000}
        totalLabel="Tổng cộng"
        totalTestId="total"
        note="Tạm tính, chưa trừ giảm giá."
      />,
    );

    expect(screen.getByTestId('price-discount')).toHaveTextContent(
      'Giảm giá GIAM20Tính khi giữ ghế',
    );
    expect(screen.getByTestId('total')).toHaveTextContent('248.000 ₫');
    expect(screen.getByText('Tạm tính, chưa trừ giảm giá.')).toBeInTheDocument();
  });

  it("after the hold: the API's subtotal, discount and total", () => {
    render(
      <PriceSummary
        lines={LINES}
        subtotal={248_000}
        voucher={{ code: 'GIAM20', discount: 49_600 }}
        total={198_400}
        totalLabel="Tổng cộng"
        totalTestId="total"
      />,
    );

    expect(screen.getByTestId('price-subtotal')).toHaveTextContent('248.000 ₫');
    expect(screen.getByTestId('price-discount')).toHaveTextContent('−49.600 ₫');
    expect(screen.getByTestId('total')).toHaveTextContent('198.400 ₫');
  });
});

describe('voucherErrorMessage', () => {
  it.each([
    [apiError(422, VoucherErrorCode.VOUCHER_NOT_AVAILABLE), 'không tồn tại hoặc đã ngừng áp dụng'],
    [
      apiError(422, VoucherErrorCode.VOUCHER_MIN_SUBTOTAL_NOT_MET, {
        minSubtotal: 500_000,
        subtotal: 229_000,
      }),
      'áp dụng cho đơn từ 500.000 ₫ (đơn này 229.000 ₫)',
    ],
    [apiError(409, VoucherErrorCode.VOUCHER_USAGE_LIMIT_REACHED), 'đã hết lượt sử dụng'],
    [apiError(409, VoucherErrorCode.VOUCHER_USER_LIMIT_REACHED), 'dùng hết số lượt của mã này'],
  ])('%#: a message for the voucher field', (error, part) => {
    expect(voucherErrorMessage(error)).toContain(part);
  });

  it('the period of a voucher not in effect, on the cinema clock', () => {
    const error = apiError(422, VoucherErrorCode.VOUCHER_NOT_IN_EFFECT, {
      startsAt: '2026-11-30T17:00:00.000Z',
      endsAt: '2026-12-31T17:00:00.000Z',
    });

    expect(voucherErrorMessage(error)).toBe(
      'Mã giảm giá chỉ áp dụng từ 00:00 Thứ Ba, 01/12/2026 đến trước 00:00 Thứ Sáu, 01/01/2027.',
    );
  });

  it('any other error is not a voucher error (it goes to the general notice)', () => {
    expect(voucherErrorMessage(apiError(409, 'SEAT_UNAVAILABLE'))).toBeUndefined();
    expect(voucherErrorMessage(new Error('boom'))).toBeUndefined();
  });
});
