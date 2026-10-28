import { validateEnv } from './env.schema';

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
    ['TRUST_PROXY', 'true'],
    ['TRUST_PROXY', 'caddy'],
    ['TRUST_PROXY', '10.0.0.0/33'],
    ['TRUST_PROXY', '-1'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => validateEnv({ ...validEnv(), [key]: value })).toThrow(new RegExp(key));
  });
});
