import { performance } from 'node:perf_hooks';
import { formatServerErrors } from '../support/server-errors';
import { holdClient } from './support/hold-client';
import {
  bootScenarioApp,
  describeScenario,
  type ScenarioApp,
  type ScenarioRoom,
  type ScenarioUser,
} from './support/scenario-app';
import { deadlockCount, doubleBookedSeats, snapshot, violations } from './support/seat-checks';
import { random, shuffle } from './support/random';
import { type Latency, latencyOf, tally, writeReport } from './support/stats';

/**
 * Scenario B (PLAN §10, ROADMAP 2.15): many users at once ask for overlapping groups of 1–6 seats
 * from a narrow block of a 10×12 room. No seat may end up in two bookings, every booking gets all
 * of its seats or none (all or nothing), and no request may fail with a 5xx or a deadlock.
 *
 * Unlike scenario A it also runs on Windows: every assertion is about answers and rows (SQL after
 * each round), none about pool usage or timing, so Docker Desktop changes nothing it checks.
 *
 * `SCENARIO_B_ROUNDS` rounds (default 50), each on a fresh showtime. Round r draws its requests
 * from seed `SEED + r`, so a failing round can be replayed alone (`SCENARIO_B_ONLY=r`).
 */
const ROUNDS = Number(process.env.SCENARIO_B_ROUNDS ?? 50);
const ONLY = process.env.SCENARIO_B_ONLY ? Number(process.env.SCENARIO_B_ONLY) : undefined;
const SEED = 20_261_029;
const REQUESTS_MIN = 40;
const REQUESTS_MAX = 60;
const SEATS_MAX = 6;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The narrow block every request draws from: 24 seats, A5–A12, B5–B12, C5–C12. */
const BLOCK = ['A', 'B', 'C'].flatMap((row) =>
  Array.from({ length: 8 }, (_, i) => `${row}${i + 5}`),
);
/** Couple pairs inside the block: a request holding one of them holds both (else 422). */
const COUPLES: [string, string][] = [
  ['B11', 'B12'],
  ['C9', 'C10'],
  ['C11', 'C12'],
];
/** What a request picks from: a single seat or a whole couple pair. */
const UNITS: string[][] = [
  ...BLOCK.filter((label) => !COUPLES.flat().includes(label)).map((label) => [label]),
  ...COUPLES,
];

/** 1–6 seats of the block, couple pairs whole, drawn with `next`. */
function seatGroup(next: () => number): string[] {
  const target = 1 + Math.floor(next() * SEATS_MAX);
  const chosen: string[] = [];
  for (const unit of shuffle(UNITS, next)) {
    if (chosen.length + unit.length <= target) chosen.push(...unit);
    if (chosen.length === target) break;
  }
  return chosen;
}

interface RoundResult {
  round: number;
  seed: number;
  requests: number;
  roundMs: number;
  answers: Record<string, number>;
  created: number;
  seatsHeld: number;
  serverErrors: number;
  latencyMs: Latency;
  violations: string[];
}

describeScenario('Scenario B — overlapping seat groups, random rounds', () => {
  let scenario: ScenarioApp;
  let room: ScenarioRoom;
  let users: ScenarioUser[];
  let deadlocksBefore: number;
  const results: RoundResult[] = [];

  beforeAll(async () => {
    scenario = await bootScenarioApp('b');
    room = await scenario.room(10, 12, COUPLES);
    // One user per request; each round is a new showtime, so the same users can book again.
    users = await scenario.users(REQUESTS_MAX);
    deadlocksBefore = await deadlockCount(scenario.db.prisma);
  });

  afterAll(async () => {
    // Backends report their statistics with a delay; give them a moment before reading.
    await pause(1_500);
    const deadlocksStat = (await deadlockCount(scenario.db.prisma)) - deadlocksBefore;
    const summary = {
      rounds: results.length,
      passed: results.filter((r) => r.violations.length === 0 && r.serverErrors === 0).length,
      requests: results.reduce((sum, r) => sum + r.requests, 0),
      created: results.reduce((sum, r) => sum + r.created, 0),
      conflicts: results.reduce((sum, r) => sum + (r.requests - r.created), 0),
      seatsHeld: results.reduce((sum, r) => sum + r.seatsHeld, 0),
      violations: results.reduce((sum, r) => sum + r.violations.length, 0),
      /** `pg_stat_database.deadlocks` increase over every round: reference only. */
      deadlocksStat,
    };
    const path = writeReport('scenario-b', {
      seed: SEED,
      block: BLOCK,
      couples: COUPLES,
      summary,
      results,
    });
    console.info(`[scenario B] summary ${JSON.stringify(summary)}; report: ${path}`);
    await scenario?.close();
  });

  const rounds = ONLY === undefined ? Array.from({ length: ROUNDS }, (_, i) => i + 1) : [ONLY];
  for (const round of rounds) {
    it(`round ${round}/${ROUNDS} (seed ${SEED + round}): all or nothing, no seat twice, no 5xx`, async () => {
      const next = random(SEED + round);
      const count = REQUESTS_MIN + Math.floor(next() * (REQUESTS_MAX - REQUESTS_MIN + 1));
      const groups = Array.from({ length: count }, () => seatGroup(next));
      const showtime = await scenario.showtime(room.id);
      const sent = groups.map((labels, i) => ({
        userId: users[i]!.id,
        token: users[i]!.token,
        seatIds: labels.map((label) => room.seat(label)),
      }));
      scenario.serverErrors.splice(0);

      const client = holdClient(scenario.baseUrl);
      const started = performance.now();
      // All at once: no request waits for another.
      const outcomes = await Promise.all(
        sent.map((s) => client.hold(s.token, { showtimeId: showtime.id, seatIds: s.seatIds })),
      );
      const roundMs = Math.round(performance.now() - started);
      client.destroy();

      const state = await snapshot(scenario.db.prisma, showtime.id);
      const found = violations(
        state,
        sent.map((s, i) => ({ userId: s.userId, seatIds: s.seatIds, ...outcomes[i]! })),
      );
      for (const row of await doubleBookedSeats(scenario.db.prisma, showtime.id)) {
        found.push(`SQL: seat ${row.seatId} in ${row.bookings} live bookings`);
      }
      const result: RoundResult = {
        round,
        seed: SEED + round,
        requests: count,
        roundMs,
        answers: tally(outcomes),
        created: outcomes.filter((o) => o.status === 201).length,
        seatsHeld: state.seats.filter((s) => s.status === 'HELD').length,
        serverErrors: outcomes.filter((o) => o.status >= 500).length,
        latencyMs: latencyOf(outcomes),
        violations: found,
      };
      results.push(result);
      console.info(
        `[scenario B] round ${round}: ${count} requests in ${roundMs} ms, ` +
          `${JSON.stringify(result.answers)}, ${result.seatsHeld} seats held` +
          (found.length > 0 ? `, VIOLATIONS ${JSON.stringify(found)}` : ''),
      );

      expect(formatServerErrors(scenario.serverErrors)).toBe('');
      expect(outcomes.filter((o) => o.status === 0 || o.status >= 500)).toEqual([]);
      // Only a win or a lost race: the requests themselves are always valid (pairs whole).
      for (const o of outcomes) {
        if (o.status !== 201) {
          expect([o.status, o.code]).toEqual([
            409,
            expect.stringMatching(/^SEAT_(LOCKED|UNAVAILABLE)$/),
          ]);
        }
      }
      expect(result.created).toBeGreaterThan(0);
      expect(found).toEqual([]);
    }, 60_000);
  }
});
