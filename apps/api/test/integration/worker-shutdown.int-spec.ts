import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { BOOKING_QUEUE, BookingJob, expireBookingJobId } from '../../src/infra/queue/booking-queue';
import { DEFAULT_JOB_OPTIONS } from '../../src/infra/queue/booking-queue.producer';
import { WORKER_SHUTDOWN_GRACE_MS } from '../../src/infra/queue/queue-workers';
import { WORKER_LOCK_TIMEOUT_MS } from '../../src/modules/bookings/booking-expiry.service';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createTestRedis, type TestRedis } from '../support/redis';

const API_ROOT = join(__dirname, '..', '..');
/** Under dist/: ignored by git, ESLint and Prettier; node_modules still resolve from apps/api. */
const BUILD_DIR = join(API_ROOT, 'dist', '.worker-shutdown');
/** Worker logs and measured times of every scenario (not committed). */
const ARTIFACTS_DIR = join(API_ROOT, '..', '..', 'artifacts', 'worker-shutdown');
const SLOW_EXPIRY_PRELOAD = join(__dirname, '..', 'support', 'worker-preload', 'slow-expiry.cjs');

/** How long the other session keeps the seats locked, or the slow statement runs. */
const BLOCKED_FOR_MS = 20_000;
/** Scenario A: released well before WORKER_LOCK_TIMEOUT_MS, so the job can still finish. */
const SHORT_LOCK_MS = 2_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` (real time) until it returns true; fails after `timeoutMs`. */
async function eventually(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`${what}: not within ${timeoutMs} ms`);
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** performance.now() when the process was gone. */
  at: number;
}

/** `node <build>/main.worker.js` as a child process, its output kept line by line. */
class WorkerProcess {
  readonly lines: string[] = [];
  readonly exited: Promise<Exit>;
  private readonly child: ChildProcess;
  private readonly started = performance.now();

  constructor(env: Record<string, string>, preload?: string) {
    const args = [...(preload ? ['-r', preload] : []), join(BUILD_DIR, 'main.worker.js')];
    this.child = spawn(process.execPath, args, {
      cwd: API_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (stream: string) => (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const at = (performance.now() - this.started).toFixed(0).padStart(6);
        this.lines.push(`[+${at} ms] ${stream} ${readable(line)}`);
      }
    };
    this.child.stdout?.on('data', collect('out'));
    this.child.stderr?.on('data', collect('err'));
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve({ code, signal, at: performance.now() }));
    });
  }

  text(): string {
    return this.lines.join('\n');
  }

  waitFor(text: string, timeoutMs = 30_000): Promise<void> {
    return eventually(
      `worker log "${text}"`,
      () => Promise.resolve(this.text().includes(text)),
      timeoutMs,
    );
  }

  /** Sends a real SIGTERM; returns when it was sent (performance.now()). */
  terminate(): number {
    const at = performance.now();
    this.child.kill('SIGTERM');
    return at;
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}

/** Pino JSON line → `level context message`, anything else as is. */
function readable(line: string): string {
  try {
    const entry = JSON.parse(line) as { level?: number; context?: string; msg?: string };
    return `${entry.level ?? ''} ${entry.context ?? ''} ${entry.msg ?? ''}`.trim();
  } catch {
    return line;
  }
}

/**
 * Worker shutdown end to end: the real worker process (compiled from src/ in beforeAll), a real
 * SIGTERM, real Postgres and Redis (ROADMAP 2.6).
 *
 * Opt-in with RUN_SIGNAL_TESTS=1, on Linux/macOS only. The suite sends a real SIGTERM to a
 * child process, which Windows cannot do (`process.kill()` ends it with TerminateProcess, a hard
 * kill no handler ever sees). Only the worker-shutdown workflow sets the variable, so a plain
 * `pnpm test:integration` skips it everywhere.
 */
const signalTestsEnabled = process.env.RUN_SIGNAL_TESTS === '1' && process.platform !== 'win32';
const describeSignal = signalTestsEnabled ? describe : describe.skip;

describeSignal('Worker shutdown on SIGTERM (real process, Linux)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let queue: Queue;
  let queueConnection: Redis;
  const workers: WorkerProcess[] = [];
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    // Fresh build of the current sources, so the test never runs a stale dist/.
    execFileSync(
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', BUILD_DIR],
      { cwd: API_ROOT, stdio: 'pipe' },
    );
    queueConnection = new Redis(redis.url, { maxRetriesPerRequest: null });
    // Same retry policy as the API producer (5 attempts, exponential backoff).
    queue = new Queue(BOOKING_QUEUE, {
      connection: queueConnection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }, 180_000);

  afterEach(async () => {
    for (const worker of workers.splice(0)) worker.kill();
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    writeFileSync(join(ARTIFACTS_DIR, 'summary.json'), JSON.stringify(results, null, 2));
    console.info(`[2.6] worker shutdown: ${JSON.stringify(results)}`);
    await queue?.close();
    await queueConnection?.quit();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  // ─── Helpers ───

  function startWorker(options: { slowExpirySeconds?: number } = {}): WorkerProcess {
    const env = {
      ...appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }, { LOG_LEVEL: 'info' }),
      ...(options.slowExpirySeconds
        ? {
            SLOW_EXPIRY_MODULE: join(BUILD_DIR, 'modules', 'bookings', 'expire-booking.js'),
            SLOW_EXPIRY_SECONDS: String(options.slowExpirySeconds),
          }
        : {}),
    };
    const worker = new WorkerProcess(
      env,
      options.slowExpirySeconds ? SLOW_EXPIRY_PRELOAD : undefined,
    );
    workers.push(worker);
    return worker;
  }

  /** Started, and its first sweep (job scheduler, at boot) is over: only our job runs next. */
  async function ready(worker: WorkerProcess): Promise<void> {
    await worker.waitFor('Worker started');
    let quietReads = 0;
    await eventually('queue idle after the boot sweep', async () => {
      const counts = await queue.getJobCounts('active', 'waiting', 'prioritized');
      quietReads = Object.values(counts).every((n) => n === 0) ? quietReads + 1 : 0;
      return quietReads >= 3;
    });
  }

  /** A PENDING booking whose hold ended a minute ago (database clock), its 2 seats HELD. */
  async function overdueBooking(): Promise<{ bookingId: string; showtimeId: string }> {
    const user = randomUUID();
    const movie = randomUUID();
    const room = randomUUID();
    const showtime = randomUUID();
    const bookingId = randomUUID();
    const seats = [randomUUID(), randomUUID()];
    await db.prisma.$executeRaw`
      INSERT INTO users (id, email, password_hash, full_name)
      VALUES (${user}::uuid, ${`shutdown-${user}@test.local`}, 'x', 'Shutdown User')`;
    await db.prisma.$executeRaw`
      INSERT INTO movies (id, title, slug, duration, age_rating, release_date)
      VALUES (${movie}::uuid, 'Shutdown Movie', ${`shutdown-${movie}`}, 100, 'P', '2026-10-01')`;
    await db.prisma.$executeRaw`
      INSERT INTO rooms (id, name, rows, cols)
      VALUES (${room}::uuid, ${`Phòng Shutdown ${room.slice(0, 8)}`}, 1, 2)`;
    for (const [i, seat] of seats.entries()) {
      await db.prisma.$executeRaw`
        INSERT INTO seats (id, room_id, row, number) VALUES (${seat}::uuid, ${room}::uuid, 'A', ${i + 1})`;
    }
    await db.prisma.$executeRaw`
      INSERT INTO showtimes (id, movie_id, room_id, starts_at, ends_at)
      VALUES (${showtime}::uuid, ${movie}::uuid, ${room}::uuid,
              now() + interval '1 day', now() + interval '1 day 2 hours')`;
    await db.prisma.$executeRaw`
      INSERT INTO bookings (id, code, user_id, showtime_id, status, subtotal, total, expires_at,
                            hold_until, idempotency_key, request_hash)
      VALUES (${bookingId}::uuid, ${`BK${bookingId.slice(0, 8).toUpperCase()}`}, ${user}::uuid,
              ${showtime}::uuid, 'PENDING', 0, 0, now() - interval '6 minutes',
              now() - interval '1 minute', ${randomUUID()}, 'shutdown')`;
    for (const seat of seats) {
      await db.prisma.$executeRaw`
        INSERT INTO showtime_seats (showtime_id, seat_id, price, status, booking_id, held_until)
        VALUES (${showtime}::uuid, ${seat}::uuid, 0, 'HELD', ${bookingId}::uuid,
                now() - interval '1 minute')`;
      await db.prisma.$executeRaw`
        INSERT INTO booking_seats (id, booking_id, showtime_id, seat_id, price)
        VALUES (${randomUUID()}::uuid, ${bookingId}::uuid, ${showtime}::uuid, ${seat}::uuid, 0)`;
    }
    return { bookingId, showtimeId: showtime };
  }

  /** Locks the showtime's seats from another session (expireBooking then waits at its step 6). */
  async function lockSeats(showtimeId: string): Promise<Client> {
    const blocker = new Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT seat_id FROM showtime_seats WHERE showtime_id = $1 ORDER BY seat_id FOR UPDATE',
      [showtimeId],
    );
    return blocker;
  }

  const enqueueExpiry = (bookingId: string) =>
    queue.add(BookingJob.EXPIRE, { bookingId }, { jobId: expireBookingJobId(bookingId) });

  /** Committed state of the booking and its seats, as any other session sees it. */
  async function state(bookingId: string) {
    const [booking] = await db.prisma.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM bookings WHERE id = ${bookingId}::uuid`;
    const seats = await db.prisma.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM showtime_seats
      WHERE showtime_id = (SELECT showtime_id FROM bookings WHERE id = ${bookingId}::uuid)
      ORDER BY seat_id`;
    return { booking: booking?.status, seats: seats.map((seat) => seat.status) };
  }

  /** Invariant: no EXPIRED booking still holds a seat, anywhere. */
  async function expiredStillHolding(): Promise<number> {
    const [row] = await db.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM showtime_seats s JOIN bookings b ON b.id = s.booking_id
      WHERE b.status = 'EXPIRED' AND s.status = 'HELD'`;
    return row?.n ?? -1;
  }

  const lockWaiters = async () =>
    (
      await db.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    )[0]?.n ?? 0;

  const sleepingStatements = async () =>
    (
      await db.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND query LIKE 'SELECT pg_sleep%'`
    )[0]?.n ?? 0;

  /** A fresh worker processes the booking left behind: EXPIRED, seats AVAILABLE, clean exit. */
  async function rerunExpires(bookingId: string, log: string[]): Promise<number> {
    const started = performance.now();
    const rerun = startWorker();
    await eventually(
      'booking expired by a new worker',
      async () => (await state(bookingId)).booking === 'EXPIRED',
      45_000,
    );
    const tookMs = Math.round(performance.now() - started);
    expect(await state(bookingId)).toEqual({
      booking: 'EXPIRED',
      seats: ['AVAILABLE', 'AVAILABLE'],
    });
    rerun.terminate();
    expect((await rerun.exited).code).toBe(0);
    log.push('── rerun ──', rerun.text());
    return tookMs;
  }

  function saveLog(scenario: string, log: string[]): void {
    writeFileSync(join(ARTIFACTS_DIR, `${scenario}.log`), `${log.join('\n')}\n`);
  }

  // ─── Scenarios ───

  it(`A: seats locked ${SHORT_LOCK_MS} ms after SIGTERM: the job finishes, exit 0 at once`, async () => {
    const worker = startWorker();
    await ready(worker);
    const { bookingId, showtimeId } = await overdueBooking();
    const blocker = await lockSeats(showtimeId);
    try {
      await enqueueExpiry(bookingId);
      await eventually('job blocked on the seat lock', async () => (await lockWaiters()) > 0);

      const sigterm = worker.terminate();
      await pause(SHORT_LOCK_MS);
      await blocker.query('ROLLBACK');
      const exit = await worker.exited;
      const exitMs = Math.round(exit.at - sigterm);
      saveLog('A-lock-released', [worker.text()]);
      results.A = { exitCode: exit.code, exitMs, state: await state(bookingId) };

      expect(exit.code).toBe(0);
      expect(exitMs).toBeGreaterThanOrEqual(SHORT_LOCK_MS);
      expect(exitMs).toBeLessThan(SHORT_LOCK_MS + 1_500);
      expect(await state(bookingId)).toEqual({
        booking: 'EXPIRED',
        seats: ['AVAILABLE', 'AVAILABLE'],
      });
      expect(await expiredStillHolding()).toBe(0);
    } finally {
      await blocker.end();
    }
  }, 90_000);

  it(`B: seats locked ${BLOCKED_FOR_MS} ms: lock_timeout (${WORKER_LOCK_TIMEOUT_MS} ms) rolls the job back, exit 0; a new worker expires it`, async () => {
    const worker = startWorker();
    await ready(worker);
    const { bookingId, showtimeId } = await overdueBooking();
    const blocker = await lockSeats(showtimeId);
    const lockedAt = performance.now();
    const log: string[] = [];
    try {
      await enqueueExpiry(bookingId);
      await eventually('job blocked on the seat lock', async () => (await lockWaiters()) > 0);

      const sigterm = worker.terminate();
      const exit = await worker.exited;
      const exitMs = Math.round(exit.at - sigterm);
      log.push(worker.text());

      expect(exit.code).toBe(0);
      // The job was already waiting when SIGTERM came: its lock_timeout ends a little sooner.
      expect(exitMs).toBeLessThan(WORKER_LOCK_TIMEOUT_MS + 1_500);
      expect(worker.text()).toContain(`Booking ${bookingId} busy`);
      const atExit = await state(bookingId);
      expect(atExit).toEqual({ booking: 'PENDING', seats: ['HELD', 'HELD'] });
      expect(await expiredStillHolding()).toBe(0);

      // The other session keeps its lock for the full 20 s, then the next worker takes over.
      await pause(Math.max(0, BLOCKED_FOR_MS - (performance.now() - lockedAt)));
      await blocker.query('ROLLBACK');
      const rerunMs = await rerunExpires(bookingId, log);
      results.B = { exitCode: exit.code, exitMs, stateAtExit: atExit, rerunMs };
      expect(await expiredStillHolding()).toBe(0);
    } finally {
      saveLog('B-lock-held-20s', log);
      await blocker.end();
    }
  }, 120_000);

  it(`C: a statement stuck ${BLOCKED_FOR_MS} ms (not a lock wait): hard deadline, exit 1 at ${WORKER_SHUTDOWN_GRACE_MS} ms, rolled back; a new worker expires it`, async () => {
    const worker = startWorker({ slowExpirySeconds: BLOCKED_FOR_MS / 1_000 });
    await ready(worker);
    const { bookingId } = await overdueBooking();
    const log: string[] = [];
    try {
      await enqueueExpiry(bookingId);
      // The expiry has written EXPIRED/AVAILABLE in its transaction and now sits in pg_sleep.
      await eventually(
        'expiry stuck in its slow statement',
        async () => (await sleepingStatements()) > 0,
      );

      const sigterm = worker.terminate();
      const exit = await worker.exited;
      const exitMs = Math.round(exit.at - sigterm);
      log.push(worker.text());

      expect(exit.code).toBe(1);
      expect(exitMs).toBeGreaterThanOrEqual(WORKER_SHUTDOWN_GRACE_MS - 100);
      expect(exitMs).toBeLessThan(WORKER_SHUTDOWN_GRACE_MS + 1_500);
      expect(worker.text()).toMatch(
        new RegExp(
          `Shutdown took longer than ${WORKER_SHUTDOWN_GRACE_MS} ms.*expire-booking.*${bookingId}`,
        ),
      );
      // Its writes never committed: everyone else still sees the hold.
      const atExit = await state(bookingId);
      expect(atExit).toEqual({ booking: 'PENDING', seats: ['HELD', 'HELD'] });

      // Postgres ends the orphaned backend once the statement returns and finds no client:
      // the transaction is rolled back, not committed.
      await eventually(
        'orphaned statement gone',
        async () => (await sleepingStatements()) === 0,
        30_000,
      );
      const afterRollback = await state(bookingId);
      expect(afterRollback).toEqual({ booking: 'PENDING', seats: ['HELD', 'HELD'] });
      expect(await expiredStillHolding()).toBe(0);

      const rerunMs = await rerunExpires(bookingId, log);
      results.C = { exitCode: exit.code, exitMs, stateAtExit: atExit, afterRollback, rerunMs };
      expect(await expiredStillHolding()).toBe(0);
    } finally {
      saveLog('C-statement-stuck-20s', log);
    }
  }, 150_000);
});
