import { z } from 'zod';
import { Role } from '../enums.js';

/** Limits shared by the API DTOs and the web forms so both validate the same way. */
export const AUTH_LIMITS = {
  emailMax: 254,
  passwordMin: 8,
  /** argon2 has no 72-byte limit like bcrypt; the cap only bounds hashing cost. */
  passwordMax: 128,
  fullNameMax: 100,
} as const;

/** Vietnamese mobile/landline: leading 0 or +84, then 9–10 digits. */
export const PHONE_PATTERN = /^(?:\+84|0)\d{9,10}$/;

/** Emails are compared and stored trimmed + lower-cased. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(AUTH_LIMITS.emailMax)
  .pipe(z.email({ error: 'Email không hợp lệ' }));

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(AUTH_LIMITS.passwordMin, {
      error: `Mật khẩu cần ít nhất ${AUTH_LIMITS.passwordMin} ký tự`,
    })
    .max(AUTH_LIMITS.passwordMax, { error: `Mật khẩu tối đa ${AUTH_LIMITS.passwordMax} ký tự` }),
  fullName: z
    .string()
    .trim()
    .min(1, { error: 'Vui lòng nhập họ tên' })
    .max(AUTH_LIMITS.fullNameMax, { error: `Họ tên tối đa ${AUTH_LIMITS.fullNameMax} ký tự` }),
  phone: z.string().trim().regex(PHONE_PATTERN, { error: 'Số điện thoại không hợp lệ' }).optional(),
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: 'Vui lòng nhập mật khẩu' }).max(AUTH_LIMITS.passwordMax),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `GET /me` and the `user` part of every auth response. */
export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  role: z.enum(Role),
  createdAt: z.string(),
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

/** Body of `POST /auth/register|login|refresh`. The refresh token travels only in a cookie. */
export const authSessionSchema = z.object({
  accessToken: z.string(),
  /** Access token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
  user: currentUserSchema,
});

export type AuthSession = z.infer<typeof authSessionSchema>;

/** Machine-readable `code` values of auth-related API errors. */
export const AuthErrorCode = {
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  REFRESH_TOKEN_MISSING: 'REFRESH_TOKEN_MISSING',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
} as const;
export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** `details` of a `429 TOO_MANY_ATTEMPTS` error. */
export const tooManyAttemptsDetailsSchema = z.object({
  retryAfterSeconds: z.number().int().nonnegative(),
});
