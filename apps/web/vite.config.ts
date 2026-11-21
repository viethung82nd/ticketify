/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One shared .env at the repo root (only VITE_* keys are exposed to the browser).
  envDir: resolve(import.meta.dirname, '../..'),
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  server: { port: 5173, strictPort: true },
  // Web unit tests (ROADMAP 5.7): Vitest + React Testing Library in jsdom, next to the code as
  // `*.test.ts(x)`. `pnpm test:unit` at the repo root runs them with the API's Jest suites.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
