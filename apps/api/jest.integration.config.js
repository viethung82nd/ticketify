const base = require('./jest.base.config');

/**
 * Integration tests against real Postgres + Redis.
 * Default: Testcontainers. Set TEST_DATABASE_URL / TEST_REDIS_URL to reuse running servers.
 * Files: test/integration/**\/*.int-spec.ts
 */
/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: 'integration',
  testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
  testTimeout: 30_000,
};
