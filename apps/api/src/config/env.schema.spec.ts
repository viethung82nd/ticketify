import { MOMO_SANDBOX_ENDPOINT, momoEndpointOf, validateEnv } from './env.schema';

const validEnv = (): Record<string, string> => ({
  CORS_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'ticketify',
  S3_SECRET_KEY: 'ticketify-secret',
  S3_BUCKET: 'tickets',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'Ticketify <no-reply@ticketify.local>',
  JWT_ACCESS_SECRET: 'unit-test-access-secret-0123456789abcdef',
  TICKET_QR_SECRET: 'unit-test-ticket-qr-secret-0123456789abc',
});

describe('validateEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = validateEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.CINEMA_TZ).toBe('Asia/Ho_Chi_Minh');
    expect(env.HOLD_TTL_SECONDS).toBe(600);
    expect(env.PAYMENT_GRACE_SECONDS).toBe(300);
    expect(env.SHOWTIME_CLEANUP_MINUTES).toBe(15);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_SECONDS).toBe(604_800);
    expect(env.LOGIN_RATE_LIMIT_MAX).toBe(5);
    expect(env.LOGIN_RATE_LIMIT_WINDOW_SECONDS).toBe(900);
    expect(env.BOOKING_RATE_LIMIT_MAX).toBe(10);
    expect(env.BOOKING_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['https://files.example.com', 'https://files.example.com'],
  ])('S3_PUBLIC_ENDPOINT=%p is optional (blank = unset)', (raw, expected) => {
    const env = validateEnv(
      raw === undefined ? validEnv() : { ...validEnv(), S3_PUBLIC_ENDPOINT: raw },
    );

    expect(env.S3_PUBLIC_ENDPOINT).toBe(expected);
  });

  it('coerces numbers and booleans', () => {
    const env = validateEnv({ ...validEnv(), PORT: '8080', S3_FORCE_PATH_STYLE: 'false' });

    expect(env.PORT).toBe(8080);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['1', 1],
    ['2', 2],
    ['loopback', ['loopback']],
    ['loopback, 172.16.0.0/12 ,10.0.0.5', ['loopback', '172.16.0.0/12', '10.0.0.5']],
    ['uniquelocal,::1,fd00::/8', ['uniquelocal', '::1', 'fd00::/8']],
  ])('parses TRUST_PROXY=%p as %p', (raw, expected) => {
    const env = validateEnv(raw === undefined ? validEnv() : { ...validEnv(), TRUST_PROXY: raw });

    expect(env.TRUST_PROXY).toEqual(expected);
  });

  it('explains why TRUST_PROXY=true is refused', () => {
    expect(() => validateEnv({ ...validEnv(), TRUST_PROXY: 'true' })).toThrow(
      /trust any client-supplied X-Forwarded-For/,
    );
  });

  it('treats blank optional VNPay values as unset', () => {
    const env = validateEnv({ ...validEnv(), VNPAY_TMN_CODE: '', VNPAY_HASH_SECRET: '' });

    expect(env.VNPAY_TMN_CODE).toBeUndefined();
    expect(env.VNPAY_HASH_SECRET).toBeUndefined();
  });

  it('fails with a readable message naming every missing variable', () => {
    const { DATABASE_URL: _db, REDIS_URL: _redis, JWT_ACCESS_SECRET: _jwt, ...rest } = validEnv();

    expect(() => validateEnv(rest)).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
    expect(() => validateEnv(rest)).toThrow(/REDIS_URL/);
    expect(() => validateEnv(rest)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it.each([
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['PORT', '70000'],
    ['CINEMA_TZ', 'Mars/Olympus'],
    ['S3_FORCE_PATH_STYLE', 'yes'],
    ['S3_PUBLIC_ENDPOINT', 'files.example.com'],
    ['S3_PUBLIC_ENDPOINT', 'ftp://files.example.com'],
    ['CORS_ORIGINS', 'not-a-url'],
    ['HOLD_TTL_SECONDS', '0'],
    ['SHOWTIME_CLEANUP_MINUTES', '-1'],
    ['SHOWTIME_CLEANUP_MINUTES', '7.5'],
    ['JWT_ACCESS_SECRET', 'too-short'],
    ['ACCESS_TOKEN_TTL_SECONDS', '0'],
    ['LOGIN_RATE_LIMIT_MAX', '-1'],
    ['BOOKING_RATE_LIMIT_MAX', '0'],
    ['BOOKING_RATE_LIMIT_WINDOW_SECONDS', '1.5'],
    ['TRUST_PROXY', 'true'],
    ['TRUST_PROXY', 'caddy'],
    ['TRUST_PROXY', '10.0.0.0/33'],
    ['TRUST_PROXY', '-1'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => validateEnv({ ...validEnv(), [key]: value })).toThrow(new RegExp(key));
  });
});

/** MoMo gateway configuration and its production rules (11/2026, review M1). Test-only values. */
describe('validateEnv — MoMo endpoint', () => {
  const KEYS = {
    MOMO_PARTNER_CODE: 'MOMOTKFTEST',
    MOMO_ACCESS_KEY: 'unitTestAccessKeyM1',
    MOMO_SECRET_KEY: 'unit-test-momo-secret-key-m1-0123456789',
  };
  const env = (overrides: Record<string, string>) => ({ ...validEnv(), ...overrides });
  const errorOf = (raw: Record<string, string>): string => {
    try {
      validateEnv(raw);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected the environment to be refused');
  };

  it('development: unset means the sandbox (convenient default kept)', () => {
    const parsed = validateEnv(env({ NODE_ENV: 'development', ...KEYS }));

    expect(parsed.MOMO_ENDPOINT).toBeUndefined();
    expect(momoEndpointOf(parsed)).toBe(MOMO_SANDBOX_ENDPOINT);
    expect(parsed.MOMO_ALLOW_SANDBOX_IN_PRODUCTION).toBe(false);
  });

  it('test: the sandbox endpoint, set explicitly, is accepted (trailing slash dropped)', () => {
    const parsed = validateEnv(
      env({ NODE_ENV: 'test', ...KEYS, MOMO_ENDPOINT: 'https://test-payment.momo.vn/' }),
    );

    expect(momoEndpointOf(parsed)).toBe('https://test-payment.momo.vn');
  });

  it('development may use http (a local fake gateway)', () => {
    expect(
      momoEndpointOf(validateEnv(env({ ...KEYS, MOMO_ENDPOINT: 'http://127.0.0.1:4010' }))),
    ).toBe('http://127.0.0.1:4010');
  });

  it('production: the sandbox endpoint is refused', () => {
    const message = errorOf(
      env({ NODE_ENV: 'production', ...KEYS, MOMO_ENDPOINT: 'https://test-payment.momo.vn' }),
    );

    expect(message).toContain("is MoMo's sandbox, refused in production");
    expect(message).toContain('MOMO_ENDPOINT');
  });

  it('production: http is refused', () => {
    const message = errorOf(
      env({ NODE_ENV: 'production', ...KEYS, MOMO_ENDPOINT: 'http://payment.momo.vn' }),
    );

    expect(message).toContain('must use https in production');
  });

  it('production: MoMo keys without an endpoint are refused (no silent sandbox default)', () => {
    expect(errorOf(env({ NODE_ENV: 'production', ...KEYS }))).toContain(
      'must be set in production when MoMo keys are set',
    );
    expect(errorOf(env({ NODE_ENV: 'production', MOMO_PARTNER_CODE: 'X' }))).toContain(
      'must be set in production',
    );
  });

  it('production: a valid https endpoint is accepted', () => {
    const parsed = validateEnv(
      env({ NODE_ENV: 'production', ...KEYS, MOMO_ENDPOINT: 'https://payment.momo.vn' }),
    );

    expect(momoEndpointOf(parsed)).toBe('https://payment.momo.vn');
  });

  it('production: the sandbox only with the explicit opt-in, and still only over https', () => {
    const optIn = { NODE_ENV: 'production', ...KEYS, MOMO_ALLOW_SANDBOX_IN_PRODUCTION: 'true' };

    expect(
      momoEndpointOf(validateEnv(env({ ...optIn, MOMO_ENDPOINT: 'https://test-payment.momo.vn' }))),
    ).toBe('https://test-payment.momo.vn');
    expect(errorOf(env({ ...optIn, MOMO_ENDPOINT: 'http://test-payment.momo.vn' }))).toContain(
      'must use https in production',
    );
    expect(errorOf(env({ ...optIn, MOMO_ALLOW_SANDBOX_IN_PRODUCTION: 'yes' }))).toContain(
      'MOMO_ALLOW_SANDBOX_IN_PRODUCTION',
    );
  });

  it('production without any MoMo key: MoMo is simply off, no endpoint, no error', () => {
    const parsed = validateEnv(env({ NODE_ENV: 'production' }));

    expect(momoEndpointOf(parsed)).toBeNull();
  });

  it('never puts a key or the endpoint value into the error', () => {
    const message = errorOf(
      env({ NODE_ENV: 'production', ...KEYS, MOMO_ENDPOINT: 'http://user:pw@payment.momo.vn' }),
    );

    for (const value of [...Object.values(KEYS), 'user:pw', 'payment.momo.vn']) {
      expect(message).not.toContain(value);
    }
  });
});

/** SePay bank transfer (11/2026): optional, validated when set. Test-only values. */
describe('validateEnv — SePay', () => {
  const env = (overrides: Record<string, string>) => ({ ...validEnv(), ...overrides });

  it('is off by default: no secret, no account, prefix TKF', () => {
    const parsed = validateEnv(validEnv());

    expect(parsed.SEPAY_WEBHOOK_SECRET).toBeUndefined();
    expect(parsed.SEPAY_BANK_ACCOUNT_NUMBER).toBeUndefined();
    expect(parsed.SEPAY_BANK_CODE).toBeUndefined();
    expect(parsed.SEPAY_PAYMENT_CODE_PREFIX).toBe('TKF');
  });

  it('treats empty values as unset', () => {
    const parsed = validateEnv(
      env({ SEPAY_WEBHOOK_SECRET: '', SEPAY_BANK_ACCOUNT_NUMBER: '', SEPAY_BANK_CODE: '' }),
    );

    expect(parsed.SEPAY_WEBHOOK_SECRET).toBeUndefined();
  });

  it('accepts a complete configuration', () => {
    const parsed = validateEnv(
      env({
        SEPAY_WEBHOOK_SECRET: 'unit-test-sepay-secret-0123',
        SEPAY_BANK_ACCOUNT_NUMBER: 'SBSEPAYX9KA2B7MN4QR',
        SEPAY_BANK_CODE: 'MBBank',
        SEPAY_ACCOUNT_HOLDER: 'CONG TY TICKETIFY',
        SEPAY_PAYMENT_CODE_PREFIX: 'TKFT',
      }),
    );

    expect(parsed.SEPAY_PAYMENT_CODE_PREFIX).toBe('TKFT');
  });

  it.each([
    ['SEPAY_WEBHOOK_SECRET', 'short'],
    ['SEPAY_BANK_ACCOUNT_NUMBER', '1017-588-888'],
    ['SEPAY_BANK_CODE', 'Vietcombank<script>'],
    ['SEPAY_PAYMENT_CODE_PREFIX', 'tkf'],
    ['SEPAY_PAYMENT_CODE_PREFIX', 'T'],
    ['SEPAY_PAYMENT_CODE_PREFIX', 'TICKET'],
    ['SEPAY_PAYMENT_CODE_PREFIX', 'TK1'],
  ])('rejects %s=%s without echoing the value', (key, value) => {
    let message = '';
    try {
      validateEnv(env({ [key]: value }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(new RegExp(key));
    if (key === 'SEPAY_WEBHOOK_SECRET') expect(message).not.toContain(value);
  });
});
