import { PaymentProvider } from '@ticketify/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentResultPage } from './payment-result-page';

// Only the HTTP client is fake.
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get, post: vi.fn() } }));

const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
/** A redirect query as MoMo sends it (the API checks it; the page never reads it). */
const SEARCH = 'partnerCode=MOMOTKF&orderId=Bq2qmIzmEDBQ2nWyKR55&resultCode=0&signature=ab';

function renderPage(provider: PaymentProvider, search = SEARCH) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const path = provider === PaymentProvider.MOMO ? '/payment/result/momo' : '/payment/result';
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`${path}?${search}`]}>
        <PaymentResultPage provider={provider} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** `GET /bookings/:id` answering a whole booking (it is parsed) with this status. */
const bookingAnswer = (status: string) => ({
  data: {
    id: BOOKING_ID,
    code: 'K7PX3MQ9TA',
    showtimeId: '01a17e75-7100-7679-b8b1-0000000000a1',
    movie: { id: '01a17e75-7100-7679-b8b1-0000000000b1', title: 'Phim', slug: 'phim' },
    showtime: {
      id: '01a17e75-7100-7679-b8b1-0000000000a1',
      startsAt: '2026-11-02T12:00:00.000Z',
      endsAt: '2026-11-02T13:55:00.000Z',
    },
    room: { id: '01a17e75-7100-7679-b8b1-0000000000d1', name: 'Phòng 1' },
    status,
    expiresAt: '2026-11-01T10:10:00.000Z',
    holdUntil: '2026-11-01T10:15:00.000Z',
    expired: false,
    seats: [],
    combos: [],
    subtotal: 180_000,
    discount: 0,
    total: 180_000,
    voucherCode: null,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  headers: {},
});

beforeEach(() => {
  get.mockReset();
});

describe('PaymentResultPage — MoMo', () => {
  it('passes the redirect query on unchanged to GET /payments/momo/return', async () => {
    get.mockResolvedValue({ data: { verified: false } });
    renderPage(PaymentProvider.MOMO);

    await screen.findByTestId('payment-unverified');
    expect(get).toHaveBeenCalledWith(`/payments/momo/return?${SEARCH}`);
  });

  it('resultCode 0 is not "paid": the page waits for the booking, which only the IPN confirms', async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/payments/momo/return')
          ? {
              data: {
                verified: true,
                bookingId: BOOKING_ID,
                paymentStatus: 'PENDING',
                resultCode: 0,
                amountMismatch: false,
              },
            }
          : bookingAnswer('PENDING'),
      ),
    );
    renderPage(PaymentProvider.MOMO);

    expect(await screen.findByTestId('payment-awaiting')).toHaveTextContent(
      'MoMo đã báo giao dịch',
    );
  });

  it('the booking CONFIRMED (by the IPN): success', async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/payments/momo/return')
          ? {
              data: {
                verified: true,
                bookingId: BOOKING_ID,
                paymentStatus: 'SUCCESS',
                resultCode: 0,
                amountMismatch: false,
              },
            }
          : bookingAnswer('CONFIRMED'),
      ),
    );
    renderPage(PaymentProvider.MOMO);

    expect(await screen.findByTestId('payment-confirmed')).toHaveTextContent(
      'Thanh toán thành công',
    );
  });

  it('a failure code (1006, declined): failed, with MoMo’s code', async () => {
    get.mockResolvedValue({
      data: {
        verified: true,
        bookingId: BOOKING_ID,
        paymentStatus: 'FAILED',
        resultCode: 1006,
        amountMismatch: false,
      },
    });
    renderPage(PaymentProvider.MOMO);

    expect(await screen.findByTestId('payment-failed')).toHaveTextContent('mã MoMo 1006');
  });

  it('a not-final code (7000): waits, never shows a failure', async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/payments/momo/return')
          ? {
              data: {
                verified: true,
                bookingId: BOOKING_ID,
                paymentStatus: 'PENDING',
                resultCode: 7000,
                amountMismatch: false,
              },
            }
          : bookingAnswer('PENDING'),
      ),
    );
    renderPage(PaymentProvider.MOMO);

    expect(await screen.findByTestId('payment-awaiting')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-failed')).not.toBeInTheDocument();
  });

  it('an amount mismatch: never treated as a success', async () => {
    get.mockResolvedValue({
      data: {
        verified: true,
        bookingId: BOOKING_ID,
        paymentStatus: 'PENDING',
        resultCode: 0,
        amountMismatch: true,
      },
    });
    renderPage(PaymentProvider.MOMO);

    expect(await screen.findByTestId('payment-unverified')).toBeInTheDocument();
  });
});

describe('PaymentResultPage — VNPay (unchanged)', () => {
  it('uses GET /payments/vnpay/return and the VNPay code', async () => {
    const search = 'vnp_TxnRef=Bq2qmIzmEDBQ2nWyKR55&vnp_ResponseCode=24';
    get.mockResolvedValue({
      data: {
        verified: true,
        bookingId: BOOKING_ID,
        paymentStatus: 'PENDING',
        vnpResponseCode: '24',
        amountMismatch: false,
      },
    });
    renderPage(PaymentProvider.VNPAY, search);

    expect(await screen.findByTestId('payment-failed')).toHaveTextContent('mã VNPay 24');
    expect(get).toHaveBeenCalledWith(`/payments/vnpay/return?${search}`);
  });
});
