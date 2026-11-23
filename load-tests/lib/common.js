// Shared helpers of the k6 scripts (ROADMAP 6.1). Runs inside k6 (goja), not Node: no npm
// imports, only k6 modules. Every setting comes from an environment variable with a default, and
// the summary records them so a result file says how it was produced.
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

export const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:3100';
export const DATA_FILE = __ENV.DATA_FILE || '/load-tests/.data/load-data.json';
export const RESULTS_DIR = __ENV.RESULTS_DIR || '';

/** Hold requests answered with one of these are the system working as designed, not failures. */
export const HOLD_EXPECTED = http.expectedStatuses(200, 201, 409);

/** Read once and shared by every VU (a plain `open()` would copy the file into each VU). */
const shared = new SharedArray('load-data', () => {
  const data = JSON.parse(open(DATA_FILE));
  return [data];
});
const users = new SharedArray('users', () => JSON.parse(open(DATA_FILE)).users);

export const loadData = () => shared[0];

/**
 * A different user for each iteration, cycling through all of them: with U users and R
 * iterations/s each user acts every U/R seconds, which keeps the per-user hold limit
 * (BOOKING_RATE_LIMIT_MAX per window) out of the measurement as long as U/R stays above
 * window / limit (60 s / 10 = 6 s by default).
 */
export function nextUser() {
  return users[exec.scenario.iterationInTest % users.length];
}

export const authHeaders = (user, extra = {}) => ({
  Authorization: `Bearer ${user.token}`,
  'Content-Type': 'application/json',
  ...extra,
});

/** Idempotency-Key: 8–64 characters of A–Z a–z 0–9 . _ ~ : - (BOOKING_LIMITS). */
export function idempotencyKey() {
  const vu = exec.vu.idInTest;
  const n = exec.scenario.iterationInTest;
  return `k6-${vu}-${n}-${Math.random().toString(36).slice(2, 10)}`;
}

export const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * 1–`max` adjacent AVAILABLE seats in one row, starting at a random available seat, like a
 * customer clicking neighbours on the map. Couple seats are left out (the load rooms have none).
 */
export function chooseSeats(seats, max) {
  const free = seats.filter((s) => s.status === 'AVAILABLE' && s.type !== 'COUPLE');
  if (free.length === 0) return [];
  const want = 1 + Math.floor(Math.random() * max);
  const first = pick(free);
  const byNumber = new Map(free.filter((s) => s.row === first.row).map((s) => [s.number, s]));
  const chosen = [first.id];
  for (let n = first.number + 1; chosen.length < want && byNumber.has(n); n++) {
    chosen.push(byNumber.get(n).id);
  }
  return chosen;
}

/** The error code of a JSON error body, or '' (k6 bodies may be null on network errors). */
export function errorCode(res) {
  try {
    return (res.json('code') || '').toString();
  } catch {
    return '';
  }
}

const TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];
export const SUMMARY_TREND_STATS = TREND_STATS;

function fmt(ms) {
  return ms === undefined ? '-' : `${ms.toFixed(1)} ms`;
}

/** Short human summary on stdout; the full k6 summary goes to `summary.json` in RESULTS_DIR. */
export function summarize(data, settings) {
  const lines = [`\nTicketify load test — ${settings.script}`];
  lines.push(`settings: ${JSON.stringify(settings)}`);
  const reqs = data.metrics.http_reqs;
  const failed = data.metrics.http_req_failed;
  if (reqs) lines.push(`requests: ${reqs.values.count} (${reqs.values.rate.toFixed(1)}/s)`);
  if (failed) lines.push(`http_req_failed: ${(failed.values.rate * 100).toFixed(3)} %`);
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (!name.startsWith('http_req_duration')) continue;
    const v = metric.values;
    lines.push(
      `${name}: p50 ${fmt(v.med)}  p95 ${fmt(v['p(95)'])}  p99 ${fmt(v['p(99)'])}  max ${fmt(v.max)}`,
    );
  }
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (metric.type === 'counter' && !name.startsWith('http_') && !name.startsWith('data_')) {
      lines.push(`${name}: ${metric.values.count}`);
    }
  }
  const dropped = data.metrics.dropped_iterations;
  lines.push(`dropped_iterations: ${dropped ? dropped.values.count : 0}`);
  return `${lines.join('\n')}\n`;
}

export function summaryOutputs(data, settings) {
  const out = { stdout: summarize(data, settings) };
  if (RESULTS_DIR) {
    out[`${RESULTS_DIR}/summary.json`] = JSON.stringify({ settings, ...data }, null, 2);
  }
  return out;
}
