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
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_SECONDS).toBe(604_800);
    expect(env.LOGIN_RATE_LIMIT_MAX).toBe(5);
    expect(env.LOGIN_RATE_LIMIT_WINDOW_SECONDS).toBe(900);
  });

  it('coerces numbers and booleans', () => {
    const env = validateEnv({ ...validEnv(), PORT: '8080', S3_FORCE_PATH_STYLE: 'false' });

    expect(env.PORT).toBe(8080);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
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
    ['CORS_ORIGINS', 'not-a-url'],
    ['HOLD_TTL_SECONDS', '0'],
    ['JWT_ACCESS_SECRET', 'too-short'],
    ['ACCESS_TOKEN_TTL_SECONDS', '0'],
    ['LOGIN_RATE_LIMIT_MAX', '-1'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => validateEnv({ ...validEnv(), [key]: value })).toThrow(new RegExp(key));
  });
});
