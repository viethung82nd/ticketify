import { VOUCHER_LIMITS, VoucherErrorCode } from '@ticketify/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError } from '@/test/api-error';
import { AdminVouchersPage } from './admin-vouchers-page';

// Only the HTTP client is fake: the page, its form rules and the shared schema run for real.
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get, post, patch: vi.fn(), delete: vi.fn() },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/admin/vouchers']}>
        <AdminVouchersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const form = screen.getByRole('form', { name: 'Thêm voucher' });
  const field = (label: string) => within(form).getByLabelText(label);
  return { form, field, user: userEvent.setup() };
}

/** Date inputs take a whole `YYYY-MM-DD` value, as a date picker sets it. */
const pickDate = (input: HTMLElement, value: string) =>
  fireEvent.change(input, { target: { value } });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
});

describe('Admin voucher form', () => {
  it('empty: the value and both days are required, and nothing is sent', async () => {
    const { form, field, user } = renderPage();

    await user.click(within(form).getByRole('button', { name: 'Thêm voucher' }));

    expect(field('Mức giảm (%)')).toHaveAccessibleDescription('Vui lòng nhập mức giảm');
    expect(field('Từ ngày')).toHaveAccessibleDescription('Chọn ngày bắt đầu');
    expect(field('Đến hết ngày')).toHaveAccessibleDescription('Chọn ngày kết thúc');
    expect(post).not.toHaveBeenCalled();
  });

  it('the rules across fields come from the shared schema: no 150 %', async () => {
    const { form, field, user } = renderPage();

    await user.type(field('Mã voucher'), 'summer10');
    await user.type(field('Mức giảm (%)'), '150');
    pickDate(field('Từ ngày'), '2026-12-01');
    pickDate(field('Đến hết ngày'), '2026-12-31');
    await user.click(within(form).getByRole('button', { name: 'Thêm voucher' }));

    expect(field('Mức giảm (%)')).toHaveAccessibleDescription(
      `Giảm theo phần trăm từ ${VOUCHER_LIMITS.percentMin} đến ${VOUCHER_LIMITS.percentMax}`,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('a fixed amount is shown with thousands separators while typing', async () => {
    const { field, user } = renderPage();

    await user.selectOptions(field('Kiểu giảm'), 'Số tiền cố định');
    await user.type(field('Mức giảm (VND)'), '20000');

    expect(field('Mức giảm (VND)')).toHaveValue('20.000');
  });

  it('valid: sends the request the API expects (code upper-cased, days as cinema instants)', async () => {
    post.mockResolvedValue({ data: {} });
    const { form, field, user } = renderPage();

    await user.type(field('Mã voucher'), ' summer10 ');
    await user.selectOptions(field('Kiểu giảm'), 'Số tiền cố định');
    await user.type(field('Mức giảm (VND)'), '20000');
    await user.type(field('Đơn tối thiểu (VND)'), '100000');
    await user.clear(field('Lượt mỗi người'));
    pickDate(field('Từ ngày'), '2026-12-01');
    pickDate(field('Đến hết ngày'), '2026-12-31');
    await user.click(within(form).getByRole('button', { name: 'Thêm voucher' }));

    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = (post.mock.calls[0] ?? []) as [string?, unknown?];
    expect(path).toBe('/admin/vouchers');
    expect(body).toMatchObject({
      code: 'SUMMER10',
      discountType: 'FIXED',
      discountValue: 20_000,
      maxDiscount: null,
      minSubtotal: 100_000,
      usageLimit: null,
      perUserLimit: null,
      // From 00:00 on the first day to 00:00 after the last one, in Vietnam.
      startsAt: '2026-12-01T00:00:00+07:00',
      endsAt: '2027-01-01T00:00:00+07:00',
    });
  });

  it('a code already taken is reported on the code field', async () => {
    post.mockRejectedValue(apiError(409, VoucherErrorCode.VOUCHER_CODE_TAKEN));
    const { form, field, user } = renderPage();

    await user.type(field('Mã voucher'), 'SUMMER10');
    await user.type(field('Mức giảm (%)'), '10');
    pickDate(field('Từ ngày'), '2026-12-01');
    pickDate(field('Đến hết ngày'), '2026-12-31');
    await user.click(within(form).getByRole('button', { name: 'Thêm voucher' }));

    await vi.waitFor(() => expect(field('Mã voucher')).toHaveAttribute('aria-invalid', 'true'));
  });

  it("the API's field errors land on the form's fields (startsAt → Từ ngày)", async () => {
    post.mockRejectedValue(
      apiError(400, 'VALIDATION_FAILED', [
        { field: 'startsAt', messages: ['Quá xa trong quá khứ'] },
      ]),
    );
    const { form, field, user } = renderPage();

    await user.type(field('Mã voucher'), 'SUMMER10');
    await user.type(field('Mức giảm (%)'), '10');
    pickDate(field('Từ ngày'), '2026-12-01');
    pickDate(field('Đến hết ngày'), '2026-12-31');
    await user.click(within(form).getByRole('button', { name: 'Thêm voucher' }));

    await vi.waitFor(() =>
      expect(field('Từ ngày')).toHaveAccessibleDescription('Quá xa trong quá khứ'),
    );
  });
});
