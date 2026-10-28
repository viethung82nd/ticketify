import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../app-config.service';
import { validateEnv } from '../env.schema';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'test-secret',
  S3_BUCKET: 'test-bucket',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'test@ticketify.local',
  JWT_ACCESS_SECRET: 'unit-test-access-secret-0123456789abcdef',
  BOOKING_RATE_LIMIT_MAX: '10',
  BOOKING_RATE_LIMIT_WINDOW_SECONDS: '60',
};

/** A validated `AppConfig` for unit tests, without loading any .env file. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return new AppConfig(new ConfigService(validateEnv({ ...BASE_ENV, ...overrides })));
}
