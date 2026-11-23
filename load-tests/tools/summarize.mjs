// Turns run folders (load-tests/results/<run>/) into Markdown tables: one row per run with the
// arrival rate, throughput, errors, dropped iterations, VUs and CPU, then the latency of every
// endpoint. Reads only what run.sh saved, so a table can always be traced back to raw files.
//   node load-tests/tools/summarize.mjs load-tests/results/<run> [<run> …]
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const runs = process.argv.slice(2);
if (runs.length === 0) {
  console.error('usage: node summarize.mjs <run folder>...');
  process.exit(2);
}

const read = (dir, file) => readFileSync(join(dir, file), 'utf8').replace(/^\uFEFF/, '');
const ms = (v) =>
  v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`;
const pct = (v) => `${(v * 100).toFixed(2)} %`;

/** Average and peak of a numeric column over samples, as "avg / peak". */
function load(samples) {
  if (samples.length === 0) return '–';
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return `${avg.toFixed(0)} / ${Math.max(...samples).toFixed(0)} %`;
}

function cpu(dir) {
  const out = { api: [], worker: [], pg: [], k6: [] };
  if (existsSync(join(dir, 'processes.csv'))) {
    const rows = read(dir, 'processes.csv')
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.split(','));
    const pids = [...new Set(rows.map((r) => r[1]))];
    // run.sh is given "API,worker" in that order.
    for (const r of rows) (r[1] === pids[0] ? out.api : out.worker).push(Number(r[2]));
  }
  if (existsSync(join(dir, 'docker-stats.csv'))) {
    for (const line of read(dir, 'docker-stats.csv').trim().split(/\r?\n/).slice(1)) {
      const [, name, value] = line.split(',');
      const n = Number.parseFloat(value);
      if (name?.includes('postgres')) out.pg.push(n);
      else if (name?.startsWith('k6-run')) out.k6.push(n);
    }
  }
  return out;
}

const overview = [
  '| Lần chạy | Rate (lượt/s) | Thời gian | Request (req/s) | Lỗi | Lượt bị bỏ | VU tối đa | CPU API | CPU Postgres | CPU k6 | Kiểm trùng |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];
const latency = [
  '| Lần chạy | Endpoint | Số request | p50 | p95 | p99 | max |',
  '|---|---|---|---|---|---|---|',
];
const counters = ['| Lần chạy | Bộ đếm |', '|---|---|'];

for (const dir of runs) {
  const meta = JSON.parse(read(dir, 'meta.json'));
  const summary = JSON.parse(read(dir, 'summary.json'));
  const m = summary.metrics;
  const run = basename(dir);
  const verify = existsSync(join(dir, 'verify.txt'))
    ? read(dir, 'verify.txt')
        .trim()
        .split(/\r?\n/)
        .filter((l) => !l.startsWith('info_'))
        .every((l) => l.trim().endsWith(' 0'))
      ? 'mọi quy tắc 0'
      : '**VI PHẠM**'
    : '–';
  const c = cpu(dir);
  overview.push(
    `| ${run} | ${summary.settings.rate} | ${summary.settings.duration} | ` +
      `${m.http_reqs.values.count} (${m.http_reqs.values.rate.toFixed(1)}) | ` +
      `${pct(m.http_req_failed.values.rate)} | ${m.dropped_iterations?.values.count ?? 0} | ` +
      `${m.vus_max.values.max ?? m.vus_max.values.value} | ${load(c.api)} | ${load(c.pg)} | ` +
      `${load(c.k6)} | ${verify} |`,
  );
  for (const [name, metric] of Object.entries(m)) {
    const match = /^http_req_duration\{name:(.+)\}$/.exec(name);
    if (!match) continue;
    const v = metric.values;
    const count = v.count ?? '–';
    latency.push(
      `| ${run} | ${match[1]} | ${count} | ${ms(v.med)} | ${ms(v['p(95)'])} | ${ms(v['p(99)'])} | ${ms(v.max)} |`,
    );
  }
  const own = Object.entries(m)
    .filter(
      ([name, metric]) => metric.type === 'counter' && /^(holds_|sold_out|bookings_)/.test(name),
    )
    .map(([name, metric]) => `${name} ${metric.values.count}`);
  counters.push(`| ${run} | ${own.join(', ') || '–'} |`);
  if (meta.api.databasePoolMax !== '10') {
    console.error(
      `${run}: DATABASE_POOL_MAX ${meta.api.databasePoolMax}, not the production default`,
    );
  }
}

console.log(overview.join('\n'));
console.log();
console.log(latency.join('\n'));
console.log();
console.log(counters.join('\n'));
