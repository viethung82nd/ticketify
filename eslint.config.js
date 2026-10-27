import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', '**/coverage/', 'apps/api/src/generated/']),

  js.configs.recommended,

  // Typed linting for every TypeScript file in the workspace.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },

  // Plain JS config files (eslint/commitlint/jest configs...).
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // API (NestJS, Node).
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Business logic must read time from ClockService so tests can control it.
    files: ['apps/api/**/*.ts'],
    ignores: ['apps/api/src/infra/clock/system-clock.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use ClockService.now() instead of `new Date()` (see CONTRIBUTING.md).',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Use ClockService.now() instead of `Date.now()` (see CONTRIBUTING.md).',
        },
      ],
    },
  },

  // Web (React, browser).
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // shadcn/ui components export their cva variant helpers next to the component.
      'react-refresh/only-export-components': [
        'error',
        { allowConstantExport: true, allowExportNames: ['buttonVariants', 'badgeVariants'] },
      ],
    },
  },

  // Must stay last: turns off stylistic rules that conflict with Prettier.
  prettier,
);
