import { Client } from 'pg';
import { TEST_ENV } from '../support/test-env';
import { takeStartedContainers } from './containers';

export default async function globalTeardown(): Promise<void> {
  const containers = takeStartedContainers();
  const pgServerUrl = process.env[TEST_ENV.pgServerUrl];
  const templateDb = process.env[TEST_ENV.templateDb];

  // On an external server, remove the template; containers are thrown away anyway.
  if (containers.length === 0 && pgServerUrl && templateDb) {
    const admin = new Client({ connectionString: pgServerUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${templateDb}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }

  await Promise.all(containers.map((container) => container.stop()));
}
