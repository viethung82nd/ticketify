import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (ROADMAP 5.8): a real browser against the built web app (`vite preview`) and
 * the built API (`node dist/main.js`) on a real Postgres and Redis. Playwright starts both
 * servers; the database must already be migrated and seeded (see e2e/README.md and
 * .github/workflows/e2e.yml).
 *
 * The VNPay page is never opened: the test catches the redirect, then plays VNPay's part with an
 * IPN and a return URL signed by the same test-only secret the API is started with.
 */
const CI = Boolean(process.env.CI);
export const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:4173';
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
/** Test-only VNPay merchant settings; never a real secret. */
export const VNPAY = {
  tmnCode: process.env.E2E_VNPAY_TMN_CODE ?? 'TKFE2E01',
  hashSecret: process.env.E2E_VNPAY_HASH_SECRET ?? 'e2e-only-vnpay-hash-secret-not-real',
} as const;

/** What the API needs to boot, on top of DATABASE_URL and REDIS_URL from the environment. */
const API_ENV = {
  NODE_ENV: 'test',
  PORT: new URL(API_URL).port || '3000',
  LOG_LEVEL: 'warn',
  CORS_ORIGINS: WEB_URL,
  TRUST_PROXY: 'false',
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  REDIS_URL: process.env.REDIS_URL ?? '',
  JWT_ACCESS_SECRET: 'e2e-only-access-secret-0123456789abcdef',
  TICKET_QR_SECRET: 'e2e-only-ticket-qr-secret-0123456789abcdef',
  // The booking flow never reaches storage or mail (the worker does); the API only needs them set.
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'e2e',
  S3_SECRET_KEY: 'e2e-secret',
  S3_BUCKET: 'e2e-bucket',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'e2e@ticketify.local',
  VNPAY_TMN_CODE: VNPAY.tmnCode,
  VNPAY_HASH_SECRET: VNPAY.hashSecret,
  VNPAY_RETURN_URL: `${WEB_URL}/payment/result`,
};

export default defineConfig({
  testDir: './e2e',
  // One flow at a time: the tests share one database and one API.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  // A second attempt only in CI, with a trace kept for the first failure.
  retries: CI ? 1 : 0,
  timeout: 60_000,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A local Chromium that does not match this Playwright version (CONTRIBUTING).
        launchOptions: process.env.E2E_CHROMIUM_PATH
          ? { executablePath: process.env.E2E_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `${API_URL}/health`,
      env: API_ENV,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite preview --port ${new URL(WEB_URL).port} --strictPort`,
      // Serves dist/ as built: VITE_API_URL was fixed at build time (default http://localhost:3000).
      url: WEB_URL,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
  ],
});
