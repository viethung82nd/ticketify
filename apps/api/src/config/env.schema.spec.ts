import { validateEnv } from './env.schema';

const validEnv = (): Record<string, string> => ({
  CORS_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_ACCESS_KEY: 'ticketify',
  MINIO_SECRET_KEY: 'ticketify-secret',
  MINIO_BUCKET: 'tickets',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'Ticketify <no-reply@ticketify.local>',
});

describe('validateEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = validateEnv(validEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.CINEMA_TZ).toBe('Asia/Ho_Chi_Minh');
    expect(env.HOLD_TTL_SECONDS).toBe(600);
    expect(env.PAYMENT_GRACE_SECONDS).toBe(300);
    expect(env.MINIO_USE_SSL).toBe(false);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('coerces numbers and booleans', () => {
    const env = validateEnv({ ...validEnv(), PORT: '8080', MINIO_USE_SSL: 'true' });

    expect(env.PORT).toBe(8080);
    expect(env.MINIO_USE_SSL).toBe(true);
  });

  it('treats blank optional VNPay values as unset', () => {
    const env = validateEnv({ ...validEnv(), VNPAY_TMN_CODE: '', VNPAY_HASH_SECRET: '' });

    expect(env.VNPAY_TMN_CODE).toBeUndefined();
    expect(env.VNPAY_HASH_SECRET).toBeUndefined();
  });

  it('fails with a readable message naming every missing variable', () => {
    const { DATABASE_URL: _db, REDIS_URL: _redis, ...rest } = validEnv();

    expect(() => validateEnv(rest)).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
    expect(() => validateEnv(rest)).toThrow(/REDIS_URL/);
  });

  it.each([
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['PORT', '70000'],
    ['CINEMA_TZ', 'Mars/Olympus'],
    ['MINIO_USE_SSL', 'yes'],
    ['CORS_ORIGINS', 'not-a-url'],
    ['HOLD_TTL_SECONDS', '0'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => validateEnv({ ...validEnv(), [key]: value })).toThrow(new RegExp(key));
  });
});
