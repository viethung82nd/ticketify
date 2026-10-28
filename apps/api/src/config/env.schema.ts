import { isIP } from 'node:net';
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

const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** A preset, an IP address, or a CIDR range (what Express' proxy-addr accepts). */
const isTrustProxyEntry = (entry: string): boolean => {
  if (TRUST_PROXY_PRESETS.has(entry)) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
};

/**
 * Express `trust proxy` — which hops may set `X-Forwarded-For`, i.e. where `req.ip` comes from.
 * - `false` (default): the socket address; right when nothing sits in front of the API.
 * - a hop count (`1` behind a single Caddy), or a list of presets / IPs / CIDRs.
 * `true` is refused: it trusts any client-supplied header, so anyone could change their IP
 * on every request and walk around the per-IP login limit.
 */
const trustProxy = z
  .string()
  .trim()
  .default('false')
  .transform((value, ctx): false | number | string[] => {
    if (value === '' || value === 'false' || value === '0') return false;
    if (/^\d+$/.test(value)) return Number(value);
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const invalid = entries.filter((entry) => !isTrustProxyEntry(entry));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          value === 'true'
            ? '"true" would trust any client-supplied X-Forwarded-For; use a hop count or proxy addresses'
            : `must be false, a hop count, or loopback/linklocal/uniquelocal/IP/CIDR (got ${invalid.join(', ')})`,
      });
      return z.NEVER;
    }
    return entries;
  });

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
  TRUST_PROXY: trustProxy,

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }),

  /** Cinema time zone used for day-based business rules (weekend/holiday pricing). */
  CINEMA_TZ: z
    .string()
    .default('Asia/Ho_Chi_Minh')
    .refine(isValidTimeZone, { error: 'must be a valid IANA time zone' }),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  PAYMENT_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(300),

  /** HS256 signing key for access tokens. Generate with `openssl rand -base64 48`. */
  JWT_ACCESS_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  /** Login attempts allowed per email inside one window (the per-IP limit is a multiple). */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  /** S3-compatible object storage (RustFS in dev). */
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  /**
   * Origin browsers use to reach the same store, when it differs from S3_ENDPOINT (e.g. the
   * API talks to http://s3:9000 inside Docker while browsers go through https://files.example.com).
   * Presigned upload/download URLs are signed for this host; HEAD/DELETE still use S3_ENDPOINT.
   */
  S3_PUBLIC_ENDPOINT: z.preprocess(blankAsUndefined, z.url({ protocol: /^https?$/ }).optional()),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  S3_BUCKET: z.string().min(3),
  S3_FORCE_PATH_STYLE: booleanString.default(true),

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
