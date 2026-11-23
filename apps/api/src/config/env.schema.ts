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
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Comma-separated list of allowed browser origins. */
    CORS_ORIGINS: commaSeparatedUrls,
    TRUST_PROXY: trustProxy,

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
    /**
     * Postgres connections per API process (node-postgres pool `max`). Seat holds fail fast with
     * NOWAIT instead of queueing on row locks, so a request only waits here, for a free connection.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }),

    /** Cinema time zone used for day-based business rules (weekend/holiday pricing). */
    CINEMA_TZ: z
      .string()
      .default('Asia/Ho_Chi_Minh')
      .refine(isValidTimeZone, { error: 'must be a valid IANA time zone' }),
    HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    PAYMENT_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(300),
    /** Cleaning time after each film: a showtime ends at startsAt + duration + this (ROADMAP 1.13). */
    SHOWTIME_CLEANUP_MINUTES: z.coerce.number().int().nonnegative().default(15),

    /** HS256 signing key for access tokens. Generate with `openssl rand -base64 48`. */
    JWT_ACCESS_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
    /** Login attempts allowed per email inside one window (the per-IP limit is a multiple). */
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
    /** `POST /bookings` requests allowed per user inside one fixed window (ROADMAP 2.9). */
    BOOKING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    BOOKING_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    /** `POST /payments/vnpay` requests allowed per user inside one fixed window (ROADMAP 3.2). */
    PAYMENT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    /** `GET /payments/vnpay/return` requests allowed per client IP inside one window (ROADMAP 3.3). */
    PAYMENT_RETURN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    PAYMENT_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

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

    /**
     * HS256 key the ticket QR tokens are signed with (ROADMAP 4.4, 4.7). Its own key, not
     * JWT_ACCESS_SECRET: a ticket token lives as long as the showtime and is printed on paper, so
     * rotating the login secret must not invalidate tickets and the reverse. Generate with
     * `openssl rand -base64 48`.
     */
    TICKET_QR_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: port,
    SMTP_FROM: z.string().min(1),

    // VNPay sandbox credentials are registered manually (see README). Optional so the API still boots
    // without them; POST /payments/vnpay then answers 503 PAYMENT_NOT_CONFIGURED (ROADMAP 3.2).
    VNPAY_TMN_CODE: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
    VNPAY_HASH_SECRET: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
    VNPAY_PAYMENT_URL: z.url().default('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'),
    VNPAY_RETURN_URL: z.preprocess(blankAsUndefined, z.url().optional()),
    /**
     * Merchant web API (`vnp_Command=querydr`, ROADMAP 3.7). The documentation read 06/11/2026
     * gives only this sandbox address and no production one, so the production value has to be
     * filled in by hand when the merchant account goes live.
     */
    VNPAY_API_URL: z
      .url({ protocol: /^https?$/ })
      .default('https://sandbox.vnpayment.vn/merchant_webapi/api/transaction'),
    /**
     * How long the expiry waits for a querydr answer. Past it the answer counts as unknown and the
     * booking expires as it did before 3.7, so the bound only has to stay well inside the expiry's
     * own job timeout.
     */
    VNPAY_QUERYDR_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5_000),

    // MoMo (API v2 gateway, one-time wallet payment). Sandbox credentials come from the MoMo
    // Business portal (docs/MOMO_SETUP.md). Optional like VNPay: without them the API still boots
    // and POST /payments/momo answers 503 PAYMENT_NOT_CONFIGURED.
    MOMO_PARTNER_CODE: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
    MOMO_ACCESS_KEY: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
    MOMO_SECRET_KEY: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
    /**
     * Base URL of the gateway; `/v2/gateway/api/create` and `/v2/gateway/api/query` are appended.
     * No schema default: outside production an unset value means MoMo's sandbox
     * (`momoEndpointOf`); in production it must be set explicitly, over https, and the sandbox is
     * refused unless `MOMO_ALLOW_SANDBOX_IN_PRODUCTION` says otherwise (`checkMomoForProduction`).
     */
    MOMO_ENDPOINT: z.preprocess(
      blankAsUndefined,
      z
        .url({ protocol: /^https?$/ })
        .transform((value) => value.replace(/\/+$/, ''))
        .optional(),
    ),
    /**
     * Lets a production build talk to MoMo's sandbox: for a controlled test deployment only (no real
     * money moves there, so any sandbox "payment" would confirm a real booking). Default `false`.
     */
    MOMO_ALLOW_SANDBOX_IN_PRODUCTION: booleanString.default(false),
    /** Where MoMo sends the browser back: the web page `/payment/result/momo`. */
    MOMO_REDIRECT_URL: z.preprocess(blankAsUndefined, z.url({ protocol: /^https?$/ }).optional()),
    /** Public URL MoMo POSTs the result to: `https://<public host>/payments/momo/ipn`. */
    MOMO_IPN_URL: z.preprocess(blankAsUndefined, z.url({ protocol: /^https?$/ }).optional()),
    /**
     * How long `POST /payments/momo` waits for MoMo's create answer. MoMo's documentation asks for a
     * timeout of at least 30 s on this call; a shorter value is allowed for tests but the default
     * follows the documentation. Past it the attempt stays PENDING and is re-sent unchanged.
     */
    MOMO_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(30_000),
    /**
     * How long the booking expiry waits for MoMo's query answer. Shorter than the create timeout on
     * purpose: an unanswered query only means the booking expires as it would without one (a late
     * IPN still records the money), and the expiry job must stay well inside its own time limit.
     */
    MOMO_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5_000),

    // SePay bank transfer (docs/SEPAY_SETUP.md): Ticketify shows a VietQR for the receiving account
    // and SePay's webhook reports the money. Optional like VNPay and MoMo: without the secret, the
    // account number or the bank, POST /payments/sepay answers 503 PAYMENT_NOT_CONFIGURED and the
    // webhook 503. SePay's payment-gateway Merchant ID / Secret Key are not used by this flow.
    /**
     * Secret Key of the SePay webhook's "HMAC-SHA256" authentication (SePay → Webhooks → Bảo mật).
     * Signs `{X-SePay-Timestamp}.{raw body}`; never logged, never sent anywhere.
     */
    SEPAY_WEBHOOK_SECRET: z.preprocess(
      blankAsUndefined,
      z.string().min(16, { error: 'must be at least 16 characters' }).optional(),
    ),
    /** The receiving account (or its VA) the QR names; a webhook for another account settles nothing. */
    SEPAY_BANK_ACCOUNT_NUMBER: z.preprocess(
      blankAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9]{4,32}$/, { error: 'must be 4–32 letters or digits' })
        .optional(),
    ),
    /** Bank of that account as VietQR knows it: short name, code or BIN (vietqr.app/banks.json). */
    SEPAY_BANK_CODE: z.preprocess(
      blankAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9 ._-]{2,40}$/, {
          error: 'must be a VietQR bank short name, code or BIN',
        })
        .optional(),
    ),
    /** Account holder printed on the page and the QR (unaccented, optional). */
    SEPAY_ACCOUNT_HOLDER: z.preprocess(blankAsUndefined, z.string().max(100).optional()),
    /**
     * Prefix of the payment code put in the transfer content; must match SePay's "Cấu trúc mã thanh
     * toán" (2–5 letters on Live). The code is this prefix + 8 digits, e.g. `TKF12345678`.
     */
    SEPAY_PAYMENT_CODE_PREFIX: z
      .string()
      .regex(/^[A-Z]{2,5}$/, { error: 'must be 2–5 upper-case letters' })
      .default('TKF'),
  })
  .superRefine((env, ctx) => checkMomoForProduction(env, ctx));

export type Env = z.infer<typeof envSchema>;

/** MoMo's sandbox gateway: the endpoint outside production when none is set. */
export const MOMO_SANDBOX_ENDPOINT = 'https://test-payment.momo.vn';
const MOMO_SANDBOX_HOSTNAME = new URL(MOMO_SANDBOX_ENDPOINT).hostname;

/**
 * The MoMo gateway to call: `MOMO_ENDPOINT` when set; otherwise the sandbox, except in
 * production, where there is none (`null`: MoMo is off and `POST /payments/momo` answers 503).
 * Validation already refused a production configuration with MoMo keys and no endpoint.
 */
export function momoEndpointOf(env: {
  NODE_ENV?: Env['NODE_ENV'];
  MOMO_ENDPOINT?: string | undefined;
}): string | null {
  if (env.MOMO_ENDPOINT) return env.MOMO_ENDPOINT;
  return env.NODE_ENV === 'production' ? null : MOMO_SANDBOX_ENDPOINT;
}

interface MomoEnv {
  NODE_ENV: Env['NODE_ENV'];
  MOMO_PARTNER_CODE?: string | undefined;
  MOMO_ACCESS_KEY?: string | undefined;
  MOMO_SECRET_KEY?: string | undefined;
  MOMO_ENDPOINT?: string | undefined;
  MOMO_ALLOW_SANDBOX_IN_PRODUCTION: boolean;
}

/**
 * Production rules of the MoMo gateway, checked once at startup with the rest of the environment
 * (11/2026, review M1). Messages name the variable and the rule, never a value: a key or a URL
 * with credentials in it never reaches the error.
 * - `MOMO_ENDPOINT` must use https;
 * - MoMo's sandbox is refused unless `MOMO_ALLOW_SANDBOX_IN_PRODUCTION=true`;
 * - with any MoMo key set, `MOMO_ENDPOINT` must be set: production never falls back to the
 *   sandbox. Without keys MoMo is simply off.
 * Development and test keep the sandbox as the default.
 */
function checkMomoForProduction(env: MomoEnv, ctx: z.RefinementCtx): void {
  if (env.NODE_ENV !== 'production') return;
  const issue = (message: string) =>
    ctx.addIssue({ code: 'custom', path: ['MOMO_ENDPOINT'], message });
  if (!env.MOMO_ENDPOINT) {
    if (env.MOMO_PARTNER_CODE || env.MOMO_ACCESS_KEY || env.MOMO_SECRET_KEY) {
      issue('must be set in production when MoMo keys are set (there is no sandbox default there)');
    }
    return;
  }
  const url = new URL(env.MOMO_ENDPOINT);
  if (url.protocol !== 'https:') issue('must use https in production');
  if (url.hostname === MOMO_SANDBOX_HOSTNAME && !env.MOMO_ALLOW_SANDBOX_IN_PRODUCTION) {
    issue(
      "is MoMo's sandbox, refused in production; set MOMO_ALLOW_SANDBOX_IN_PRODUCTION=true " +
        'only for a controlled test deployment',
    );
  }
}

/** Validates raw environment variables; throws a readable, multi-line error on failure. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
