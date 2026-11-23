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

/**
 * Read once and shared by every VU (a plain `open()` would copy the file into each VU). One
 * SharedArray per list, read element by element: k6 decodes a SharedArray element on EVERY
 * access, so a single element holding the whole file (≈ 1.5 MB with 5 000 tokens) was decoded on
 * every iteration and made k6 the bottleneck (about 5 cores at 100 iterations/s, 24/11/2026).
 */
const meta = new SharedArray('meta', () => {
  const { hotShowtimeId, hotShowtimeStartsAt, generatedAt, tokenExpiresAt } = JSON.parse(
    open(DATA_FILE),
  );
  return [{ hotShowtimeId, hotShowtimeStartsAt, generatedAt, tokenExpiresAt }];
});
const users = new SharedArray('users', () => JSON.parse(open(DATA_FILE)).users);
export const movies = new SharedArray('movies', () => JSON.parse(open(DATA_FILE)).movies);
export const futureShowtimes = new SharedArray(
  'future-showtimes',
  () => JSON.parse(open(DATA_FILE)).futureShowtimes,
);

let metaOfThisVu;
/** Hot showtime id and the data file's timestamps (decoded once per VU). */
export function loadMeta() {
  if (!metaOfThisVu) metaOfThisVu = meta[0];
  return metaOfThisVu;
}

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

/** GJSON path (evaluated in Go by `res.json(path)`) to the free, non-couple seats of a seat map. */
const FREE_SEATS = 'seats.#(status=="AVAILABLE")#';

/**
 * 1–`max` adjacent AVAILABLE seats in one row, starting at a random available seat, like a
 * customer clicking neighbours on the map. Couple seats are left out (the load rooms have none).
 *
 * Takes the seat-map RESPONSE, not parsed JSON: the free seats are filtered with GJSON in Go, and
 * only their ids, rows and numbers reach JavaScript. Parsing the whole 31 KB map in k6's JS engine
 * on every iteration made k6 itself the bottleneck (about 6 cores at 100 iterations/s, measured
 * 24/11/2026), on the same machine as the API.
 */
export function chooseSeats(res, max) {
  const ids = res.json(`${FREE_SEATS}.id`) || [];
  if (ids.length === 0) return [];
  const rows = res.json(`${FREE_SEATS}.row`);
  const numbers = res.json(`${FREE_SEATS}.number`);
  const types = res.json(`${FREE_SEATS}.type`);
  const free = ids
    .map((id, i) => ({ id, row: rows[i], number: numbers[i], type: types[i] }))
    .filter((s) => s.type !== 'COUPLE');
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

const TREND_STATS = ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];
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
    if (metric.type === 'counter' && !/^(http_|data_|dropped_iterations)/.test(name)) {
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
