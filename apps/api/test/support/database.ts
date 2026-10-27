import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { requiredEnv, TEST_ENV, withDatabase } from './test-env';

/** Serializes CREATE DATABASE … TEMPLATE across parallel workers. */
const CLONE_LOCK_ID = 7_240_001;

export interface TestDatabase {
  /** Connection string of this suite's private database. */
  url: string;
  prisma: PrismaClient;
  /** Disconnects and drops the database. Call in afterAll. */
  drop(): Promise<void>;
}

async function withAdmin<T>(work: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: requiredEnv(TEST_ENV.pgServerUrl) });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/**
 * Creates a fresh, fully migrated database for one test suite by cloning the template
 * prepared in global setup (much faster than re-running migrations).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const template = requiredEnv(TEST_ENV.templateDb);
  const name = `ticketify_test_${randomUUID().replaceAll('-', '')}`;

  await withAdmin(async (admin) => {
    await admin.query('SELECT pg_advisory_lock($1)', [CLONE_LOCK_ID]);
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [CLONE_LOCK_ID]);
    }
  });

  const url = withDatabase(requiredEnv(TEST_ENV.pgServerUrl), name);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  return {
    url,
    prisma,
    async drop() {
      await prisma.$disconnect();
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}
