/** Shared Jest settings for the unit and integration projects. */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2023',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The generated Prisma client uses NodeNext-style '.js' specifiers for its .ts files.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  clearMocks: true,
};
