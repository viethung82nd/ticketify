/**
 * Environment for booting `AppModule` in an integration suite. Assign it to `process.env`
 * *before* importing the module graph: ConfigModule validates and caches env at import time.
 */
export function appTestEnv(
  urls: { databaseUrl: string; redisUrl: string },
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'http://localhost:5173',
    // Explicit so a local .env cannot change req.ip in tests.
    TRUST_PROXY: 'false',
    DATABASE_URL: urls.databaseUrl,
    REDIS_URL: urls.redisUrl,
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test-secret',
    S3_BUCKET: 'test-bucket',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    SMTP_FROM: 'test@ticketify.local',
    JWT_ACCESS_SECRET: 'integration-test-access-secret-0123456789',
    BOOKING_RATE_LIMIT_MAX: '10',
    BOOKING_RATE_LIMIT_WINDOW_SECONDS: '60',
    ...overrides,
  };
}
