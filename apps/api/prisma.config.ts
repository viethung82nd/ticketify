import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env itself. Commands run from apps/api; the shared
// .env lives at the repo root. Real environment variables always win.
loadEnv({ path: ['.env', '../../.env'], quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` does not need a database, so a missing URL is allowed here;
    // commands that do need one fail with Prisma's own error.
    url: process.env.DATABASE_URL ?? '',
  },
});
