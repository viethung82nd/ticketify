import { performance } from 'node:perf_hooks';
import { formatServerErrors } from '../support/server-errors';
import { holdClient, SCENARIO_MAX_SOCKETS } from './support/hold-client';
import { type PoolUsage, samplePool } from './support/pool-sampler';
import {
  bootScenarioApp,
  SCENARIO_POOL_MAX,
  type ScenarioApp,
  type ScenarioRoom,
} from './support/scenario-app';
import { deadlockCount, snapshot, violations } from './support/seat-checks';
import { type Latency, latencyOf, tally, writeReport } from './support/stats';

/**
 * Scenario A (PLAN §10, ROADMAP 2.14): 500 different users send `POST /bookings` for the same seat
 * of the same showtime at the same moment. Exactly one gets 201, the other 499 get 409
 * (SEAT_LOCKED or SEAT_UNAVAILABLE), never a 5xx; the pool is never exhausted.
 *
 * Run `SCENARIO_A_RUNS` times (default 10) in a row, each on a fresh showtime with 500 new users.
 * Numbers per run go to the console and to `artifacts/scenarios/scenario-a.json`.
 */
/**
 * Opt-in like every scenario (RUN_SCENARIO_TESTS=1), and Linux/macOS only. On Windows the API runs
 * on the host and Postgres inside Docker Desktop: the answers are still right (one 201, no 5xx), but
 * the pool reaches 40/40 busy connections, mostly `idle in transaction` (waiting for the API to send
 * its next statement, not working in Postgres), so the pool assertion does not hold there. Scenario
 * A is accepted on Linux (the `booking-scenarios` workflow).
 */
const runScenarioA = process.env.RUN_SCENARIO_TESTS === '1' && process.platform !== 'win32';
const describeScenarioA = runScenarioA ? describe : describe.skip;

const RUNS = Number(process.env.SCENARIO_A_RUNS ?? 10);
const CROWD = 500;
const SEAT = 'A3';

interface RunResult {
  run: number;
  totalMs: number;
  answers: Record<string, number>;
  created: number;
  conflicts: number;
  serverErrors: number;
  networkErrors: number;
  latencyMs: Latency;
  pool: PoolUsage;
  /** `pg_stat_database.deadlocks` increase over the run: reference only (reported late). */
  deadlocksStat: number;
  violations: string[];
}

describeScenarioA(`Scenario A — ${CROWD} users hold the same seat at once`, () => {
  let scenario: ScenarioApp;
  let room: ScenarioRoom;
  const results: RunResult[] = [];

  beforeAll(async () => {
    scenario = await bootScenarioApp('a');
    room = await scenario.room(1, 5);
  });

  afterAll(async () => {
    const path = writeReport('scenario-a', {
      crowd: CROWD,
      runs: RUNS,
      poolMax: SCENARIO_POOL_MAX,
      maxSockets: SCENARIO_MAX_SOCKETS,
      platform: process.platform,
      results,
    });
    console.info(`[scenario A] report: ${path}`);
    await scenario?.close();
  });

  for (let run = 1; run <= RUNS; run++) {
    it(`run ${run}/${RUNS}: exactly one 201, ${CROWD - 1} × 409, no 5xx, pool below ${SCENARIO_POOL_MAX}`, async () => {
      const users = await scenario.users(CROWD);
      const showtime = await scenario.showtime(room.id);
      const seatId = room.seat(SEAT);
      const body = { showtimeId: showtime.id, seatIds: [seatId] };
      const deadlocksBefore = await deadlockCount(scenario.db.prisma);
      scenario.serverErrors.splice(0);

      const client = holdClient(scenario.baseUrl);
      const pool = await samplePool(scenario.db.url, scenario.applicationName, SCENARIO_POOL_MAX);
      const started = performance.now();
      const outcomes = await Promise.all(users.map((user) => client.hold(user.token, body)));
      const totalMs = Math.round(performance.now() - started);
      const poolUsage = await pool.stop();
      client.destroy();

      const state = await snapshot(scenario.db.prisma, showtime.id);
      const found = violations(
        state,
        outcomes.map((o, i) => ({ userId: users[i]!.id, seatIds: [seatId], ...o })),
      );
      const result: RunResult = {
        run,
        totalMs,
        answers: tally(outcomes),
        created: outcomes.filter((o) => o.status === 201).length,
        conflicts: outcomes.filter((o) => o.status === 409).length,
        serverErrors: outcomes.filter((o) => o.status >= 500).length,
        networkErrors: outcomes.filter((o) => o.status === 0).length,
        latencyMs: latencyOf(outcomes),
        pool: poolUsage,
        deadlocksStat: (await deadlockCount(scenario.db.prisma)) - deadlocksBefore,
        violations: found,
      };
      results.push(result);
      console.info(
        `[scenario A] run ${run}: ${totalMs} ms, ${JSON.stringify(result.answers)}, ` +
          `p50 ${result.latencyMs.p50} / p95 ${result.latencyMs.p95} / p99 ${result.latencyMs.p99} ms, ` +
          `pool busy ≤ ${poolUsage.maxBusy} (active ≤ ${poolUsage.maxActive}, idle in tx ≤ ${poolUsage.maxIdleInTransaction}), ` +
          `open ≤ ${poolUsage.maxOpen}, at max in ${poolUsage.samplesAtMax}/${poolUsage.samples} samples`,
      );

      expect(formatServerErrors(scenario.serverErrors)).toBe('');
      expect(result.networkErrors).toBe(0);
      expect(result.serverErrors).toBe(0);
      expect(result.created).toBe(1);
      expect(result.conflicts).toBe(CROWD - 1);
      for (const o of outcomes.filter((x) => x.status === 409)) {
        expect(['SEAT_LOCKED', 'SEAT_UNAVAILABLE']).toContain(o.code);
      }
      // One booking, one booking_seats line, one seat pointing at it; nothing else changed.
      expect(found).toEqual([]);
      const winner = outcomes.find((o) => o.status === 201)!;
      expect(state.bookings.map((b) => [b.id, b.seatIds])).toEqual([[winner.bookingId, [seatId]]]);
      expect(state.seats.filter((s) => s.bookingId !== null)).toEqual([
        expect.objectContaining({ seatId, status: 'HELD', bookingId: winner.bookingId }),
      ]);
      expect(
        await scenario.db.prisma.bookingSeat.count({ where: { showtimeId: showtime.id, seatId } }),
      ).toBe(1);
      // The pool never ran out: some connection was always free.
      expect(poolUsage.samples).toBeGreaterThan(0);
      expect(poolUsage.maxOpen).toBeLessThanOrEqual(SCENARIO_POOL_MAX);
      expect(poolUsage.maxBusy).toBeLessThan(SCENARIO_POOL_MAX);
    }, 120_000);
  }
});
