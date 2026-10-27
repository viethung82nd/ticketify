const base = require('./jest.base.config');

/** Unit tests: fast, no external services. Files: src/**\/*.spec.ts */
/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: 'unit',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
};
