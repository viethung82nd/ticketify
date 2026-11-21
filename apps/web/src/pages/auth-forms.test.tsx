import { AUTH_LIMITS, AuthErrorCode } from '@ticketify/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { login, register } from '@/features/auth/auth-api';
import { apiError, networkError } from '@/test/api-error';
import { LoginPage } from './login-page';
import { RegisterPage } from './register-page';

vi.mock('@/features/auth/auth-api', () => ({ login: vi.fn(), register: vi.fn() }));
const loginMock = vi.mocked(login);
const registerMock = vi.mocked(register);

/** The page at its route, with the page a successful sign-in goes back to. */
function renderAt(path: '/login' | '/register', from?: string) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/', element: <p>Trang chủ</p> },
      { path: '/me/bookings', element: <p>Vé của tôi</p> },
    ],
    { initialEntries: [{ pathname: path, state: from ? { from } : null }] },
  );
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

const field = (label: string) => screen.getByLabelText(label);

beforeEach(() => {
  loginMock.mockReset();
  registerMock.mockReset();
});

describe('Login form', () => {
  it('empty: each field says what is missing, is marked invalid, and nothing is sent', async () => {
    const { user } = renderAt('/login');

    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(field('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(field('Mật khẩu')).toHaveAttribute('aria-invalid', 'true');
    // The message is the field's description, read with it by a screen reader.
    expect(field('Email')).toHaveAccessibleDescription(/email/i);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('a malformed email is refused before any request', async () => {
    const { user } = renderAt('/login');

    await user.type(field('Email'), 'khong-phai-email');
    await user.type(field('Mật khẩu'), 'mat-khau-dai');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(field('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('valid: signs in with what was typed and returns to the page the visitor came from', async () => {
    loginMock.mockResolvedValue(undefined as never);
    const { router, user } = renderAt('/login', '/me/bookings');

    await user.type(field('Email'), 'An@Example.com');
    await user.type(field('Mật khẩu'), 'mat-khau-dai');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(await screen.findByText('Vé của tôi')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/me/bookings');
    expect(loginMock).toHaveBeenCalledWith(expect.objectContaining({ password: 'mat-khau-dai' }));
  });

  it.each([
    [
      'wrong credentials',
      apiError(401, AuthErrorCode.INVALID_CREDENTIALS),
      'Email hoặc mật khẩu không đúng.',
    ],
    [
      'too many attempts',
      apiError(429, AuthErrorCode.TOO_MANY_ATTEMPTS, { retryAfterSeconds: 290 }),
      'Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 5 phút.',
    ],
    ['no connection', networkError(), 'Không kết nối được máy chủ. Vui lòng thử lại sau.'],
  ])('%s: an alert on the form, the visitor stays on the page', async (_label, error, message) => {
    loginMock.mockRejectedValue(error);
    const { router, user } = renderAt('/login');

    await user.type(field('Email'), 'an@example.com');
    await user.type(field('Mật khẩu'), 'mat-khau-dai');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(router.state.location.pathname).toBe('/login');
  });
});

describe('Register form', () => {
  it(`a password under ${AUTH_LIMITS.passwordMin} characters and a bad phone are refused`, async () => {
    const { user } = renderAt('/register');

    await user.type(field('Họ và tên'), 'Nguyễn Văn An');
    await user.type(field('Email'), 'an@example.com');
    await user.type(field('Số điện thoại (không bắt buộc)'), '12ab');
    await user.type(field('Mật khẩu'), 'ngan');
    await user.click(screen.getByRole('button', { name: 'Đăng ký' }));

    expect(field('Mật khẩu')).toHaveAccessibleDescription(
      `Mật khẩu cần ít nhất ${AUTH_LIMITS.passwordMin} ký tự`,
    );
    expect(field('Số điện thoại (không bắt buộc)')).toHaveAccessibleDescription(
      'Số điện thoại không hợp lệ',
    );
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('the password hint is the field description until there is an error', () => {
    renderAt('/register');

    expect(field('Mật khẩu')).toHaveAccessibleDescription(
      `Ít nhất ${AUTH_LIMITS.passwordMin} ký tự.`,
    );
  });

  it('a blank phone is left out, the rest is sent', async () => {
    registerMock.mockResolvedValue(undefined as never);
    const { user } = renderAt('/register');

    await user.type(field('Họ và tên'), '  Nguyễn Văn An ');
    await user.type(field('Email'), 'an@example.com');
    await user.type(field('Mật khẩu'), 'mat-khau-dai');
    await user.click(screen.getByRole('button', { name: 'Đăng ký' }));

    expect(await screen.findByText('Trang chủ')).toBeInTheDocument();
    const sent = registerMock.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ fullName: 'Nguyễn Văn An', password: 'mat-khau-dai' });
    // undefined, so JSON.stringify leaves it out of the request body.
    expect(sent?.phone).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('phone');
  });

  it('an email already registered: an alert, nothing else changes', async () => {
    registerMock.mockRejectedValue(apiError(409, AuthErrorCode.EMAIL_TAKEN));
    const { user } = renderAt('/register');

    await user.type(field('Họ và tên'), 'Nguyễn Văn An');
    await user.type(field('Email'), 'an@example.com');
    await user.type(field('Mật khẩu'), 'mat-khau-dai');
    await user.click(screen.getByRole('button', { name: 'Đăng ký' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email này đã được đăng ký. Hãy đăng nhập hoặc dùng email khác.',
    );
  });
});
