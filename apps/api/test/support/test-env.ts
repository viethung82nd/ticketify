/** Contract between the Jest global setup (parent process) and test workers. */

/** Same images as docker-compose.yml so tests run against the versions we develop on. */
export const POSTGRES_IMAGE = 'postgres:16.15-alpine';
export const REDIS_IMAGE = 'redis:7.4.12-alpine';

/** Environment variables written by global setup and read by workers. */
export const TEST_ENV = {
  /** Connection to a database on the server that may CREATE/DROP databases. */
  pgServerUrl: 'TICKETIFY_TEST_PG_SERVER_URL',
  /** Fully migrated database that every suite clones. */
  templateDb: 'TICKETIFY_TEST_TEMPLATE_DB',
  redisUrl: 'TICKETIFY_TEST_REDIS_URL',
} as const;

/** Optional user-provided servers (skip Testcontainers when set). */
export const EXTERNAL_ENV = {
  databaseUrl: 'TEST_DATABASE_URL',
  redisUrl: 'TEST_REDIS_URL',
} as const;

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — run integration tests through "pnpm test:integration".`);
  }
  return value;
}

/** Returns `url` pointing at another database on the same server. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
