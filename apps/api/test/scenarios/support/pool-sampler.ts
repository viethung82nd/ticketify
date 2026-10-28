import { Client } from 'pg';

/** How often `samplePool` reads `pg_stat_activity`. */
export const POOL_SAMPLE_INTERVAL_MS = 50;

export interface PoolUsage {
  samples: number;
  /** Most connections of the API that were open at one sample. */
  maxOpen: number;
  /** Most connections of the API that were not idle (running a query or inside a transaction). */
  maxBusy: number;
  /** Most connections running a statement ('active') at one sample. */
  maxActive: number;
  /**
   * Most connections inside a transaction but waiting for the API to send its next statement
   * ('idle in transaction'): checked out of the pool, yet not working in Postgres.
   */
  maxIdleInTransaction: number;
  /** Samples at which every connection of the pool was busy. */
  samplesAtMax: number;
}

/**
 * Reads, every 50 ms, how many connections the API (`application_name`) has open and how many of
 * them are busy, from `pg_stat_activity` on its own connection. A sample is a snapshot: a peak
 * shorter than 50 ms between two samples is not seen, so `maxBusy` is a lower bound.
 */
export async function samplePool(databaseUrl: string, applicationName: string, poolMax: number) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const usage: PoolUsage = {
    samples: 0,
    maxOpen: 0,
    maxBusy: 0,
    maxActive: 0,
    maxIdleInTransaction: 0,
    samplesAtMax: 0,
  };
  let running = true;

  const loop = (async () => {
    while (running) {
      const { rows } = await client.query<{
        open: number;
        busy: number;
        active: number;
        idle_in_tx: number;
      }>(
        `SELECT count(*)::int AS open,
                count(*) FILTER (WHERE state <> 'idle')::int AS busy,
                count(*) FILTER (WHERE state = 'active')::int AS active,
                count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_tx
         FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1`,
        [applicationName],
      );
      const row = rows[0] ?? { open: 0, busy: 0, active: 0, idle_in_tx: 0 };
      usage.samples += 1;
      usage.maxOpen = Math.max(usage.maxOpen, row.open);
      usage.maxBusy = Math.max(usage.maxBusy, row.busy);
      usage.maxActive = Math.max(usage.maxActive, row.active);
      usage.maxIdleInTransaction = Math.max(usage.maxIdleInTransaction, row.idle_in_tx);
      if (row.busy >= poolMax) usage.samplesAtMax += 1;
      await new Promise((resolve) => setTimeout(resolve, POOL_SAMPLE_INTERVAL_MS));
    }
  })();

  return {
    async stop(): Promise<PoolUsage> {
      running = false;
      await loop;
      await client.end();
      return usage;
    },
  };
}
