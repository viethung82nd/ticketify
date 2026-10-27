import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import {
  EXTERNAL_ENV,
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  TEST_ENV,
  withDatabase,
} from '../support/test-env';
import { setStartedContainers, type StoppableContainer } from './containers';

const API_ROOT = join(__dirname, '..', '..');

/**
 * Runs once before all integration suites:
 * 1. Start Postgres + Redis with Testcontainers (or reuse TEST_DATABASE_URL / TEST_REDIS_URL).
 * 2. Create a template database and apply every migration to it — including the
 *    hand-written SQL constraints — with `prisma migrate deploy`, exactly like production.
 * Each suite then clones the template (see support/database.ts).
 */
export default async function globalSetup(): Promise<void> {
  const containers: StoppableContainer[] = [];
  let pgServerUrl = process.env[EXTERNAL_ENV.databaseUrl];
  let redisUrl = process.env[EXTERNAL_ENV.redisUrl];

  if (!pgServerUrl) {
    const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    containers.push(postgres);
    pgServerUrl = postgres.getConnectionUri();
  }
  if (!redisUrl) {
    const redis = await new RedisContainer(REDIS_IMAGE).start();
    containers.push(redis);
    redisUrl = redis.getConnectionUrl();
  }
  setStartedContainers(containers);

  // Unique name so several runs can share an external server.
  const templateDb = `ticketify_test_tpl_${process.pid}`;
  const admin = new Client({ connectionString: pgServerUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${templateDb}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${templateDb}"`);
  } finally {
    await admin.end();
  }

  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: withDatabase(pgServerUrl, templateDb) },
    stdio: 'pipe',
  });

  // Workers are spawned after global setup, so they inherit these.
  process.env[TEST_ENV.pgServerUrl] = pgServerUrl;
  process.env[TEST_ENV.templateDb] = templateDb;
  process.env[TEST_ENV.redisUrl] = redisUrl;
}
