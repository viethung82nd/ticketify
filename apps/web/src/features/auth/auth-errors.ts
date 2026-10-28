import { AuthErrorCode, tooManyAttemptsDetailsSchema } from '@ticketify/shared';
import { apiErrorOf, isNetworkError } from '@/lib/api-error';

/** Vietnamese message for an auth API failure, based on its error `code`. */
export function authErrorMessage(error: unknown): string {
  if (isNetworkError(error)) return 'Không kết nối được máy chủ. Vui lòng thử lại sau.';

  const apiError = apiErrorOf(error);
  switch (apiError?.code) {
    case AuthErrorCode.INVALID_CREDENTIALS:
      return 'Email hoặc mật khẩu không đúng.';
    case AuthErrorCode.EMAIL_TAKEN:
      return 'Email này đã được đăng ký. Hãy đăng nhập hoặc dùng email khác.';
    case AuthErrorCode.TOO_MANY_ATTEMPTS: {
      const details = tooManyAttemptsDetailsSchema.safeParse(apiError.details);
      const minutes = details.success
        ? Math.max(1, Math.ceil(details.data.retryAfterSeconds / 60))
        : 15;
      return `Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút.`;
    }
    case 'VALIDATION_FAILED':
      return 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.';
    default:
      return 'Đã có lỗi xảy ra. Vui lòng thử lại.';
  }
}
