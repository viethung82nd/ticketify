import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HoldOutcome } from './hold-client';

/** Scenario numbers land here (repo root, git-ignored); CI uploads the folder as an artifact. */
export const SCENARIO_ARTIFACTS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'artifacts',
  'scenarios',
);

/** Nearest-rank percentile of `values` (any order), rounded to 0.1 ms. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return Math.round(sorted[rank - 1]! * 10) / 10;
}

export interface Latency {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function latencyOf(outcomes: readonly HoldOutcome[]): Latency {
  const ms = outcomes.map((o) => o.ms);
  return {
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    max: percentile(ms, 100),
  };
}

/** `{ "201": 1, "409 SEAT_LOCKED": 412, ... }`: how many answers of each kind. */
export function tally(outcomes: readonly HoldOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of outcomes) {
    const key =
      o.status === 0
        ? `network ${o.networkError ?? ''}`.trim()
        : o.code && o.status >= 400
          ? `${o.status} ${o.code}`
          : String(o.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Writes `report` as `<name>.json` in the artifacts folder and returns the path. */
export function writeReport(name: string, report: unknown): string {
  mkdirSync(SCENARIO_ARTIFACTS_DIR, { recursive: true });
  const path = join(SCENARIO_ARTIFACTS_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
