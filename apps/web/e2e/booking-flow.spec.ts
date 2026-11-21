import { expect, test } from '@playwright/test';
import { API_URL } from '../playwright.config';
import { createScene } from './support/scene';
import { paidResult } from './support/vnpay';

/**
 * The main customer flow end to end (ROADMAP 5.8, PLAN §10): sign in → pick a showtime → pick
 * seats → hold → pay through VNPay (simulated) → see the ticket. The browser drives the real
 * web app and API; only VNPay is played by the test, with the same signed IPN and return URL a
 * real payment would produce.
 */
test('sign in, pick seats, pay, see the confirmed booking and its tickets', async ({
  page,
  request,
}) => {
  const scene = await createScene(request);

  await test.step('sign in', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(scene.user.email);
    await page.getByLabel('Mật khẩu').fill(scene.user.password);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });

  await test.step('pick the showtime from the movie page', async () => {
    await page.goto(`/movies/${scene.movie.slug}`);
    await page.locator(`[data-date="${scene.date}"]`).click();
    await page.getByRole('link', { name: new RegExp(scene.room.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/showtimes/${scene.showtime.id}/book`));
  });

  let bookingId = '';
  await test.step('pick two seats and hold them', async () => {
    const continueButton = page.getByRole('button', { name: 'Tiếp tục' });
    await page.locator('[data-seat="A3"]').click();
    await page.locator('[data-seat="A4"]').click();
    await expect(page.getByRole('list', { name: 'Danh sách ghế đã chọn' })).toContainText('A3');
    await expect(page.getByRole('list', { name: 'Danh sách ghế đã chọn' })).toContainText('A4');
    // Enabled once the realtime connection is live.
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
    bookingId = page.url().split('/').pop() ?? '';
    await expect(page.getByRole('timer', { name: 'Thời gian giữ ghế còn lại' })).toBeVisible();
  });

  let payUrl = '';
  await test.step('pay: the redirect to VNPay is caught, never sent', async () => {
    await page.route('https://sandbox.vnpayment.vn/**', (route) => {
      payUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>VNPay (e2e)</h1>' });
    });
    await page.getByTestId('pay-vnpay').click();
    await page.waitForURL(/sandbox\.vnpayment\.vn/);
    expect(new URL(payUrl).searchParams.get('vnp_TxnRef')).toBeTruthy();
  });

  await test.step('VNPay calls the IPN, then sends the customer back', async () => {
    const result = paidResult(payUrl, String(Date.now()).slice(-8));
    const ipn = await request.get(`${API_URL}/payments/vnpay/ipn?${result}`);
    expect(await ipn.json()).toEqual({ RspCode: '00', Message: 'Confirm Success' });

    await page.goto(`/payment/result?${result}`);
    await expect(page.getByTestId('payment-confirmed')).toBeVisible();
  });

  await test.step('the booking is confirmed, with its ticket download', async () => {
    await page.goto(`/bookings/${bookingId}`);
    await expect(page.getByRole('status').filter({ hasText: 'Đã xác nhận' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tải vé PDF' })).toBeVisible();

    await page.getByRole('link', { name: 'Vé của tôi' }).first().click();
    const row = page.getByRole('listitem').filter({ hasText: scene.room.name });
    await expect(row).toContainText('Đã xác nhận');
    await expect(row).toContainText('Ghế A3, A4');
  });

  await test.step('the two seats are sold for everyone', async () => {
    const map = (await (
      await request.get(`${API_URL}/showtimes/${scene.showtime.id}/seats`)
    ).json()) as {
      seats: { label: string; status: string }[];
    };
    const sold = map.seats.filter((seat) => seat.status === 'SOLD').map((seat) => seat.label);
    expect(sold.sort()).toEqual(['A3', 'A4']);
  });
});
