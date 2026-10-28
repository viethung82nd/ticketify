const base = require('./jest.base.config');

/**
 * Concurrency scenarios A and B (PLAN §10, ROADMAP 2.14–2.15) against real Postgres + Redis.
 * Opt-in: without RUN_SCENARIO_TESTS=1 every suite is skipped and no container is started.
 * One suite at a time (maxWorkers 1): each measures latency and pool use, so they must not share
 * the machine or the Postgres server with another suite.
 * Files: test/scenarios/**\/*.spec.ts
 */
/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: 'scenarios',
  testMatch: ['<rootDir>/test/scenarios/**/*.spec.ts'],
  globalSetup: '<rootDir>/test/scenarios/support/global-setup.ts',
  globalTeardown: '<rootDir>/test/scenarios/support/global-teardown.ts',
  maxWorkers: 1,
  // Per-run and per-round numbers are printed with console.info.
  verbose: true,
  testTimeout: 30_000,
};
