import { PaymentErrorCode } from '@ticketify/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError } from '@/test/api-error';
import { PaymentOptions } from './payment-options';

// The HTTP client and the page change are fake; the component, its schemas and messages are real.
const { get, post, leaveTo } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  leaveTo: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get, post } }));
vi.mock('@/lib/navigation', () => ({ leaveTo }));

const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f1';
const PAY_URL = 'https://test-payment.momo.vn/v2/gateway/pay?t=abc';

function renderOptions() {
  const onStale = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PaymentOptions bookingId={BOOKING_ID} onStale={onStale} />
    </QueryClientProvider>,
  );
  const group = screen.getByRole('group', { name: 'Chọn phương thức thanh toán' });
  return {
    onStale,
    user: userEvent.setup(),
    vnpay: within(group).getByTestId('pay-vnpay'),
    momo: within(group).getByTestId('pay-momo'),
    sepay: within(group).getByTestId('pay-sepay'),
  };
}

beforeEach(() => {
  post.mockReset();
  leaveTo.mockReset();
  // The transfer panel polls the booking; it never answers here (the page owns that query).
  get.mockReset();
  get.mockReturnValue(new Promise(() => undefined));
});

/** `201` of `POST /payments/sepay` (test values; nothing secret is ever in it). */
const SEPAY_CREATED = {
  paymentId: PAYMENT_ID,
  provider: 'SEPAY',
  amount: 180_000,
  transferContent: 'TKF04817263',
  qrCodeUrl:
    'https://vietqr.app/img?acc=0071000888999&bank=MBBank&amount=180000&des=TKF04817263&template=compact',
  bankCode: 'MBBank',
  accountNumber: '0071000888999',
  accountHolder: 'CONG TY TICKETIFY',
  expiresAt: '2099-11-01T10:10:00.000Z',
  reused: false,
};

describe('PaymentOptions', () => {
  it('offers VNPay and the MoMo wallet', () => {
    const { vnpay, momo } = renderOptions();

    expect(vnpay).toHaveTextContent('Thanh toán qua VNPay');
    expect(momo).toHaveTextContent('Thanh toán qua ví MoMo');
  });

  it('MoMo: sends only the booking id (never an amount) and goes to the payUrl; both buttons stay disabled', async () => {
    post.mockResolvedValue({
      data: {
        paymentId: PAYMENT_ID,
        orderId: 'Bq2qmIzmEDBQ2nWyKR55',
        payUrl: PAY_URL,
        expiresAt: '2026-11-01T10:10:00.000Z',
        reused: false,
      },
    });
    const { user, vnpay, momo } = renderOptions();

    await user.click(momo);

    expect(post).toHaveBeenCalledWith('/payments/momo', { bookingId: BOOKING_ID });
    expect(leaveTo).toHaveBeenCalledWith(PAY_URL);
    expect(momo).toHaveTextContent('Đang chuyển sang MoMo…');
    expect(momo).toBeDisabled();
    expect(vnpay).toBeDisabled();
  });

  it('VNPay still goes through POST /payments/vnpay', async () => {
    post.mockResolvedValue({
      data: {
        paymentId: PAYMENT_ID,
        txnRef: 'Bq2qmIzmEDBQ2nWyKR55',
        paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?x=1',
        expiresAt: '2026-11-01T10:10:00.000Z',
      },
    });
    const { user, vnpay } = renderOptions();

    await user.click(vnpay);

    expect(post).toHaveBeenCalledWith('/payments/vnpay', { bookingId: BOOKING_ID });
    expect(leaveTo).toHaveBeenCalledWith('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?x=1');
  });

  it.each([
    [503, PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE, 'Cổng thanh toán chưa phản hồi'],
    [502, PaymentErrorCode.PAYMENT_PROVIDER_ERROR, 'Cổng thanh toán từ chối tạo giao dịch'],
    [422, PaymentErrorCode.PAYMENT_AMOUNT_NOT_SUPPORTED, 'hạn mức của ví MoMo'],
    [503, PaymentErrorCode.PAYMENT_NOT_CONFIGURED, 'đang tạm ngưng'],
  ])('%i %s: a message, the buttons usable again, no page change', async (status, code, text) => {
    post.mockRejectedValue(apiError(status, code));
    const { user, vnpay, momo, onStale } = renderOptions();

    await user.click(momo);

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(momo).toBeEnabled();
    expect(vnpay).toBeEnabled();
    expect(leaveTo).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('422 BOOKING_EXPIRED: the booking shown is reloaded', async () => {
    post.mockRejectedValue(apiError(422, PaymentErrorCode.BOOKING_EXPIRED));
    const { user, momo, onStale } = renderOptions();

    await user.click(momo);

    expect(await screen.findByRole('alert')).toHaveTextContent('Đã hết thời gian thanh toán');
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('offers a bank transfer through SePay', () => {
    const { sepay } = renderOptions();

    expect(sepay).toHaveTextContent('Chuyển khoản ngân hàng (VietQR)');
  });

  it('SePay: sends only the booking id, shows the QR, the exact amount and content, and waits; the page never changes', async () => {
    post.mockResolvedValue({ data: SEPAY_CREATED });
    const { user, sepay } = renderOptions();

    await user.click(sepay);

    expect(post).toHaveBeenCalledWith('/payments/sepay', { bookingId: BOOKING_ID });
    const panel = await screen.findByTestId('sepay-panel');
    expect(within(panel).getByTestId('sepay-qr')).toHaveAttribute('src', SEPAY_CREATED.qrCodeUrl);
    expect(within(panel).getByTestId('sepay-amount')).toHaveTextContent('180.000 ₫');
    expect(within(panel).getByTestId('sepay-content')).toHaveTextContent('TKF04817263');
    expect(within(panel).getByTestId('sepay-account')).toHaveTextContent('0071000888999');
    expect(within(panel).getByRole('status')).toHaveTextContent('Đang chờ ngân hàng báo nhận tiền');
    expect(within(panel).getByTestId('sepay-countdown')).toHaveTextContent(/^\d{2,}:\d{2}$/);
    expect(leaveTo).not.toHaveBeenCalled();
    // The booking is read again (polling) to learn when the webhook confirmed it.
    expect(get).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}`);
  });

  it('SePay: one click at a time; every method is disabled until the API answers', async () => {
    let answer: (value: unknown) => void = () => undefined;
    post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { user, sepay, vnpay, momo } = renderOptions();

    await user.click(sepay);
    await user.click(sepay);

    expect(sepay).toBeDisabled();
    expect(sepay).toHaveTextContent('Đang tạo mã chuyển khoản…');
    expect(vnpay).toBeDisabled();
    expect(momo).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
    answer({ data: SEPAY_CREATED });
    expect(await screen.findByTestId('sepay-panel')).toBeInTheDocument();
  });

  it('SePay: "Chọn phương thức khác" goes back to the list', async () => {
    post.mockResolvedValue({ data: SEPAY_CREATED });
    const { user, sepay } = renderOptions();
    await user.click(sepay);

    await user.click(await screen.findByRole('button', { name: 'Chọn phương thức khác' }));

    expect(screen.queryByTestId('sepay-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('pay-sepay')).toBeEnabled();
  });

  it('SePay 503 PAYMENT_NOT_CONFIGURED: a message, no panel, the buttons usable again', async () => {
    post.mockRejectedValue(apiError(503, PaymentErrorCode.PAYMENT_NOT_CONFIGURED));
    const { user, sepay, vnpay } = renderOptions();

    await user.click(sepay);

    expect(await screen.findByRole('alert')).toHaveTextContent('đang tạm ngưng');
    expect(screen.queryByTestId('sepay-panel')).not.toBeInTheDocument();
    expect(sepay).toBeEnabled();
    expect(vnpay).toBeEnabled();
  });

  it('SePay 409 BOOKING_ALREADY_PAID: the booking shown is reloaded', async () => {
    post.mockRejectedValue(apiError(409, PaymentErrorCode.BOOKING_ALREADY_PAID));
    const { user, sepay, onStale } = renderOptions();

    await user.click(sepay);

    expect(await screen.findByRole('alert')).toHaveTextContent('đã được thanh toán');
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});
