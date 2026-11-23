/**
 * Coverage gate (ROADMAP 6.4, PLAN §9): the unit AND integration projects in one Jest run, so
 * their coverage is merged, then checked against the thresholds below. Run by CI on every PR
 * instead of the two separate API test steps.
 *
 *   pnpm --filter @ticketify/api test:coverage
 *
 * Integration needs Postgres + Redis like `test:integration` (Testcontainers, or TEST_DATABASE_URL
 * / TEST_REDIS_URL). Scenario suites (test/scenarios) and the Playwright e2e are not part of it.
 */
/** @type {import('jest').Config} */
module.exports = {
  projects: ['<rootDir>/jest.unit.config.js', '<rootDir>/jest.integration.config.js'],
  // testTimeout is a global option: Jest ignores it inside a project, so the integration value is
  // repeated here. Without it the integration suites ran with the 5 s default, and a test that
  // holds a lock for 3 s timed out and left its rows to break the next one (booking-expiry).
  testTimeout: require('./jest.integration.config').testTimeout,
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/testing/**',
    '!src/generated/**',
    // Process entry points: they only bootstrap Nest (listen, signal handlers, Swagger) and are
    // exercised as real processes (worker-shutdown.int-spec spawns the compiled worker, the e2e
    // workflow starts the API), never loaded in-process where Jest could instrument them.
    '!src/main.ts',
    '!src/main.worker.ts',
    '!src/swagger.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
  // PLAN §9: total >= 80 %, core modules (booking, payment, tickets, outbox) >= 90 %. Lines and
  // statements carry the PLAN numbers; branches and functions have floors under what the suites
  // reach today (24/11/2026: total branches 86.5 %, core 86.5–93.3 %), so a PR that drops
  // coverage noticeably fails without the gate demanding a test for every defensive branch.
  // A directory key is checked on that directory's summary, and its files leave "global".
  coverageThreshold: {
    global: { lines: 80, statements: 80, functions: 80, branches: 80 },
    './src/modules/bookings/': { lines: 90, statements: 90, functions: 90, branches: 85 },
    './src/modules/payment/': { lines: 90, statements: 90, functions: 90, branches: 85 },
    './src/modules/tickets/': { lines: 90, statements: 90, functions: 90, branches: 85 },
    './src/infra/outbox/': { lines: 90, statements: 90, functions: 85, branches: 85 },
  },
};
