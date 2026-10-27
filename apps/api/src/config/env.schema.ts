import { z } from 'zod';

/** Treat `KEY=` (empty string) the same as an unset variable. */
const blankAsUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const port = z.coerce.number().int().min(1).max(65535);

const booleanString = z
  .enum(['true', 'false'], { error: 'must be "true" or "false"' })
  .transform((value) => value === 'true');

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const commaSeparatedUrls = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })).min(1));

/**
 * Single source of truth for API configuration.
 * Every key here must also appear in the repo-root `.env.example` (enforced by a unit test).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: commaSeparatedUrls,

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }),

  /** Cinema time zone used for day-based business rules (weekend/holiday pricing). */
  CINEMA_TZ: z
    .string()
    .default('Asia/Ho_Chi_Minh')
    .refine(isValidTimeZone, { error: 'must be a valid IANA time zone' }),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  PAYMENT_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(300),

  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: port,
  MINIO_USE_SSL: booleanString.default(false),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(8),
  MINIO_BUCKET: z.string().min(3),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: port,
  SMTP_FROM: z.string().min(1),

  // VNPay sandbox credentials are registered manually (see README); optional until phase 3.
  VNPAY_TMN_CODE: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
  VNPAY_HASH_SECRET: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
  VNPAY_PAYMENT_URL: z.url().default('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'),
  VNPAY_RETURN_URL: z.preprocess(blankAsUndefined, z.url().optional()),
});

export type Env = z.infer<typeof envSchema>;

/** Validates raw environment variables; throws a readable, multi-line error on failure. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
