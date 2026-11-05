import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  CreateBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { OutboxEventType } from '../../src/infra/outbox/outbox-events';
import { DELIVERY_QUEUE } from '../../src/infra/queue/delivery-queue';
import { DELIVERY_JOB_OPTIONS } from '../../src/infra/queue/delivery-queue.producer';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createTestRedis, type TestRedis } from '../support/redis';
import { EXTERNAL_S3_ENV, MAILPIT_IMAGE, RUSTFS_IMAGE } from '../support/test-env';

const API_ROOT = join(__dirname, '..', '..');
/** Under dist/: ignored by git, ESLint and Prettier; node_modules still resolve from apps/api. */
const BUILD_DIR = join(API_ROOT, 'dist', '.scenario-d');
/** Worker logs and the measured outcome of every phase (not committed). */
const ARTIFACTS_DIR = join(API_ROOT, '..', '..', 'artifacts', 'scenario-d');
const STALL_MAILER_PRELOAD = join(__dirname, '..', 'support', 'worker-preload', 'stall-mailer.cjs');

const ACCESS_KEY = process.env[EXTERNAL_S3_ENV.accessKey] ?? 'ticketify';
const SECRET_KEY = process.env[EXTERNAL_S3_ENV.secretKey] ?? 'ticketify-secret';
const REGION = 'us-east-1';

/**
 * Long enough that the test can kill the worker while a message is in flight, and far longer than
 * any step takes on its own.
 */
const MAILER_STALL_SECONDS = 120;

/**
 * BullMQ notices a job whose worker vanished only once its lock expires (30 s) and the next
 * stalled check runs (every 30 s), so recovery after a hard kill takes up to about a minute.
 */
const RECOVERY_TIMEOUT_MS = 120_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` (real time) until it returns true; fails with `what` after `timeoutMs`. */
async function eventually(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 250) {
    if (await check()) return;
    await pause(250);
  }
  throw new Error(`${what}: not within ${timeoutMs} ms`);
}

/** A TCP port nothing listens on, for "SMTP is down". */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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

/** `node <build>/main.worker.js` as a child process, its output kept line by line. */
class WorkerProcess {
  readonly lines: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: ChildProcess;
  private readonly started = performance.now();

  constructor(
    readonly label: string,
    env: Record<string, string>,
    preload?: string,
  ) {
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
      this.child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  text(): string {
    return this.lines.join('\n');
  }

  waitFor(text: string, timeoutMs = 60_000): Promise<void> {
    return eventually(
      `${this.label} log "${text}"`,
      () => Promise.resolve(this.text().includes(text)),
      timeoutMs,
    );
  }

  /** A hard kill: no signal handler runs, nothing is flushed — the crash scenario D is about. */
  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    this.kill();
    await this.exited;
  }
}

/**
 * Scenario D (ROADMAP 4.9): ticket delivery survives a worker killed mid-job, an SMTP outage and
 * an object store that cannot be reached.
 *
 * Everything here is real: the compiled worker as its own process, hard-killed with SIGKILL;
 * Postgres and Redis; RustFS for storage; Mailpit for SMTP. The only thing simulated is the
 * payment itself — the suite writes what an IPN would have committed (a CONFIRMED booking with
 * its tickets, and the `booking.confirmed` outbox row) and then watches the worker deliver it.
 *
 * Opt-in with RUN_SCENARIO_D=1, because it starts containers, builds the worker and waits out
 * BullMQ's stalled-job recovery (about a minute per kill). `pnpm test:integration` skips it.
 */
const enabled = process.env.RUN_SCENARIO_D === '1';
const describeD = enabled ? describe : describe.skip;

describeD('Scenario D — delivery survives a crash, SMTP and storage outages', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let rustfs: StartedTestContainer;
  let mailpit: StartedTestContainer;
  let s3: S3Client;
  let s3Endpoint: string;
  let smtpHost: string;
  let smtpPort: number;
  let mailpitApi: string;
  let queue: Queue;
  let queueConnection: Redis;
  const bucket = `ticketify-d-${randomUUID().slice(0, 8)}`;
  const workers: WorkerProcess[] = [];
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    [db, redis, rustfs, mailpit] = await Promise.all([
      createTestDatabase(),
      createTestRedis(),
      new GenericContainer(RUSTFS_IMAGE)
        .withEnvironment({
          RUSTFS_ACCESS_KEY: ACCESS_KEY,
          RUSTFS_SECRET_KEY: SECRET_KEY,
          RUSTFS_VOLUMES: '/data',
          RUSTFS_ADDRESS: '0.0.0.0:9000',
        })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200))
        .start(),
      new GenericContainer(MAILPIT_IMAGE)
        .withExposedPorts(1025, 8025)
        .withWaitStrategy(Wait.forHttp('/readyz', 8025).forStatusCode(200))
        .start(),
    ]);
    s3Endpoint = `http://${rustfs.getHost()}:${rustfs.getMappedPort(9000)}`;
    smtpHost = mailpit.getHost();
    smtpPort = mailpit.getMappedPort(1025);
    mailpitApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
    s3 = s3Client(s3Endpoint);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    // A fresh build of the current sources, so the suite never runs a stale dist/.
    execFileSync(
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', BUILD_DIR],
      { cwd: API_ROOT, stdio: 'pipe' },
    );
    queueConnection = new Redis(redis.url, { maxRetriesPerRequest: null });
    queue = new Queue(DELIVERY_QUEUE, {
      connection: queueConnection,
      defaultJobOptions: DELIVERY_JOB_OPTIONS,
    });
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }, 300_000);

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
  });

  afterAll(async () => {
    writeFileSync(join(ARTIFACTS_DIR, 'summary.json'), JSON.stringify(results, null, 2));
    console.info(`[4.9] scenario D: ${JSON.stringify(results)}`);
    await queue?.close();
    await queueConnection?.quit();
    s3?.destroy();
    await Promise.allSettled([rustfs?.stop(), mailpit?.stop()]);
    await Promise.all([db?.drop(), redis?.close()]);
  }, 120_000);

  // ─── Helpers ───

  function s3Client(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
  }

  function startWorker(label: string, overrides: Record<string, string> = {}): WorkerProcess {
    const stalled = overrides.STALL_MAILER_SECONDS !== undefined;
    const env = {
      ...appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          LOG_LEVEL: 'info',
          S3_ENDPOINT: s3Endpoint,
          S3_ACCESS_KEY: ACCESS_KEY,
          S3_SECRET_KEY: SECRET_KEY,
          S3_BUCKET: bucket,
          S3_REGION: REGION,
          S3_FORCE_PATH_STYLE: 'true',
          SMTP_HOST: smtpHost,
          SMTP_PORT: String(smtpPort),
          SMTP_FROM: 'Ticketify <no-reply@ticketify.test>',
        },
      ),
      ...(stalled
        ? { STALL_MAILER_MODULE: join(BUILD_DIR, 'infra', 'mailer', 'smtp-mailer.js') }
        : {}),
      ...overrides,
    };
    const worker = new WorkerProcess(label, env, stalled ? STALL_MAILER_PRELOAD : undefined);
    workers.push(worker);
    return worker;
  }

  /** What an IPN leaves behind: a CONFIRMED booking with a ticket per seat, and the outbox row. */
  async function paidBooking(): Promise<{
    bookingId: string;
    code: string;
    userId: string;
    email: string;
    eventId: string;
    ticketCodes: string[];
  }> {
    const ids = {
      user: randomUUID(),
      movie: randomUUID(),
      room: randomUUID(),
      showtime: randomUUID(),
      booking: randomUUID(),
      payment: randomUUID(),
    };
    const seats = [randomUUID(), randomUUID()];
    const email = `scenario-d-${ids.booking.slice(0, 8)}@test.local`;
    const code = `BK${ids.booking.slice(0, 8).toUpperCase()}`;
    const ticketCodes = seats.map(
      (_, index) => `D${ids.booking.slice(0, 10).toUpperCase()}${index}`,
    );

    await db.prisma.$executeRaw`
      INSERT INTO users (id, email, password_hash, full_name)
      VALUES (${ids.user}::uuid, ${email}, 'x', 'Nguyễn Thị Hồng Nhung')`;
    await db.prisma.$executeRaw`
      INSERT INTO movies (id, title, slug, duration, age_rating, release_date)
      VALUES (${ids.movie}::uuid, 'Mắt Biếc — Người Đẹp Và Thủy Quái',
              ${`mat-biec-${ids.movie.slice(0, 8)}`}, 100, 'P', '2026-10-01')`;
    await db.prisma.$executeRaw`
      INSERT INTO rooms (id, name, rows, cols)
      VALUES (${ids.room}::uuid, ${`Phòng ${ids.room.slice(0, 4)}`}, 1, 2)`;
    for (const [index, seat] of seats.entries()) {
      await db.prisma.$executeRaw`
        INSERT INTO seats (id, room_id, "row", number, type)
        VALUES (${seat}::uuid, ${ids.room}::uuid, 'A', ${index + 1}, 'STANDARD')`;
    }
    await db.prisma.$executeRaw`
      INSERT INTO showtimes (id, movie_id, room_id, starts_at, ends_at)
      VALUES (${ids.showtime}::uuid, ${ids.movie}::uuid, ${ids.room}::uuid,
              now() + interval '2 hours', now() + interval '4 hours')`;
    await db.prisma.$executeRaw`
      INSERT INTO bookings (id, code, user_id, showtime_id, status, subtotal, total,
                            expires_at, hold_until, confirmed_at, idempotency_key, request_hash)
      VALUES (${ids.booking}::uuid, ${code}, ${ids.user}::uuid, ${ids.showtime}::uuid,
              'CONFIRMED', 180000, 180000, now(), now(), now(), ${randomUUID()}, 'hash')`;
    for (const seat of seats) {
      await db.prisma.$executeRaw`
        INSERT INTO showtime_seats (showtime_id, seat_id, status, booking_id, price)
        VALUES (${ids.showtime}::uuid, ${seat}::uuid, 'SOLD', ${ids.booking}::uuid, 90000)`;
      await db.prisma.$executeRaw`
        INSERT INTO booking_seats (id, booking_id, showtime_id, seat_id, price)
        VALUES (${randomUUID()}::uuid, ${ids.booking}::uuid, ${ids.showtime}::uuid,
                ${seat}::uuid, 90000)`;
    }
    await db.prisma.$executeRaw`
      INSERT INTO payments (id, booking_id, txn_ref, amount, status, processed_at)
      VALUES (${ids.payment}::uuid, ${ids.booking}::uuid,
              ${ids.payment.replaceAll('-', '').slice(0, 20)}, 180000, 'SUCCESS', now())`;
    const ticketIds: string[] = [];
    for (const [index, seat] of seats.entries()) {
      const ticketId = randomUUID();
      ticketIds.push(ticketId);
      await db.prisma.$executeRaw`
        INSERT INTO tickets (id, booking_id, showtime_id, seat_id, code, status)
        VALUES (${ticketId}::uuid, ${ids.booking}::uuid, ${ids.showtime}::uuid, ${seat}::uuid,
                ${ticketCodes[index]!}, 'ISSUED')`;
    }
    const event = await db.prisma.outboxEvent.create({
      data: {
        type: OutboxEventType.BOOKING_CONFIRMED,
        aggregateId: ids.booking,
        payload: {
          bookingId: ids.booking,
          bookingCode: code,
          userId: ids.user,
          showtimeId: ids.showtime,
          paymentId: ids.payment,
          seatIds: seats,
          ticketIds,
          reclaimed: false,
        },
      },
      select: { id: true },
    });

    return {
      bookingId: ids.booking,
      code,
      userId: ids.user,
      email,
      eventId: event.id,
      ticketCodes,
    };
  }

  const outboxRow = (id: string) =>
    db.prisma.outboxEvent.findUniqueOrThrow({
      where: { id },
      select: { status: true, attempts: true, lastError: true },
    });

  const emailSentAt = async (bookingId: string): Promise<Date | null> =>
    (
      await db.prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { emailSentAt: true },
      })
    ).emailSentAt;

  const notificationCount = (bookingId: string) =>
    db.prisma.notification.count({ where: { data: { path: ['bookingId'], equals: bookingId } } });

  interface MailpitSummary {
    ID: string;
    To: { Address: string }[];
    Attachments: number;
  }

  async function mailFor(address: string): Promise<MailpitSummary[]> {
    const res = await fetch(`${mailpitApi}/api/v1/messages?limit=200`);
    const body = (await res.json()) as { messages: MailpitSummary[] };
    return body.messages.filter((message) => message.To.some((to) => to.Address === address));
  }

  const pdfExists = async (client: S3Client, bookingId: string): Promise<boolean> => {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `tickets/${bookingId}.pdf` }));
      return true;
    } catch {
      return false;
    }
  };

  /** Every delivery job that is not `completed`, by state, for the report. */
  const jobCounts = () => queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');

  /** The invariants that must hold after every phase, over the whole database. */
  async function violations() {
    const q = <T>(sql: TemplateStringsArray) => db.prisma.$queryRaw<T[]>(sql);
    const [duplicateTickets, unpublished, doubleNotifications, ticketCountMismatch] =
      await Promise.all([
        q`SELECT showtime_id, seat_id, count(*)::int AS n FROM tickets WHERE status <> 'VOID'
          GROUP BY showtime_id, seat_id HAVING count(*) > 1`,
        q`SELECT id, type, status::text AS status, attempts, last_error FROM outbox_events
          WHERE status <> 'PUBLISHED'`,
        q`SELECT user_id, event_id, count(*)::int AS n FROM notifications
          WHERE event_id IS NOT NULL GROUP BY user_id, event_id HAVING count(*) > 1`,
        q`SELECT b.id FROM bookings b WHERE b.status = 'CONFIRMED'
          AND (SELECT count(*) FROM tickets t WHERE t.booking_id = b.id AND t.status <> 'VOID')
            <> (SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id)`,
      ]);
    return { duplicateTickets, unpublished, doubleNotifications, ticketCountMismatch };
  }

  const NO_VIOLATIONS = {
    duplicateTickets: [],
    unpublished: [],
    doubleNotifications: [],
    ticketCountMismatch: [],
  };

  /** Everything a delivered booking must end up with, whatever happened on the way. */
  async function expectDelivered(
    booking: { bookingId: string; email: string; eventId: string },
    client: S3Client,
  ): Promise<void> {
    await eventually(
      'the email arrived',
      async () => (await mailFor(booking.email)).length > 0,
      RECOVERY_TIMEOUT_MS,
    );
    const mail = await mailFor(booking.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.Attachments).toBe(1);
    expect(await emailSentAt(booking.bookingId)).not.toBeNull();
    expect(await outboxRow(booking.eventId)).toMatchObject({ status: 'PUBLISHED' });
    expect(await pdfExists(client, booking.bookingId)).toBe(true);
    const objects = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `tickets/${booking.bookingId}` }),
    );
    expect((objects.Contents ?? []).map((item) => item.Key)).toEqual([
      `tickets/${booking.bookingId}.pdf`,
    ]);
    expect(await notificationCount(booking.bookingId)).toBe(1);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  }

  // ─── D1: the worker is killed with a message in flight ───

  it('a worker killed mid-delivery loses nothing: the restart finishes the job, once', async () => {
    const booking = await paidBooking();
    const first = startWorker('worker#1', {
      STALL_MAILER_SECONDS: String(MAILER_STALL_SECONDS),
    });

    // The PDF is uploaded and the e-mail is in flight: the moment after the database commit.
    await first.waitFor(`Booking ${booking.code}:`);
    await first.waitFor('STALL mailer: holding the message');
    expect(await emailSentAt(booking.bookingId)).toBeNull();
    expect(await mailFor(booking.email)).toEqual([]);
    expect(await pdfExists(s3, booking.bookingId)).toBe(true);

    // A hard kill: no handler runs, the job keeps its BullMQ lock until it expires.
    first.kill();
    expect(await first.exited).toMatchObject({ signal: 'SIGKILL' });
    expect(await emailSentAt(booking.bookingId)).toBeNull();
    expect(await mailFor(booking.email)).toEqual([]);

    const second = startWorker('worker#2');
    await second.waitFor('Worker started');
    await expectDelivered(booking, s3);

    results.killedWorker = {
      bookingCode: booking.code,
      emails: (await mailFor(booking.email)).length,
      outbox: await outboxRow(booking.eventId),
      jobs: await jobCounts(),
    };
    writeFileSync(
      join(ARTIFACTS_DIR, 'd1-killed-worker.log'),
      `${first.text()}\n---\n${second.text()}`,
    );
  }, 300_000);

  // ─── D2: SMTP refuses every connection, then comes back ───

  it('an SMTP outage holds the email back and nothing else, and the retry sends it once', async () => {
    const booking = await paidBooking();
    const dead = await closedPort();
    const broken = startWorker('worker#smtp-down', { SMTP_PORT: String(dead) });

    await broken.waitFor('Worker started');
    // The PDF and the notification go through: an SMTP outage blocks only the email.
    await eventually('the PDF was uploaded', () => pdfExists(s3, booking.bookingId));
    await eventually(
      'the notification was stored',
      async () => (await notificationCount(booking.bookingId)) === 1,
    );
    await eventually('the send-email job failed at least once', async () => {
      const failed = await queue.getJobs(['failed', 'delayed']);
      return failed.some((job) => job?.name === 'send-email' && job.attemptsMade >= 1);
    });
    expect(await emailSentAt(booking.bookingId)).toBeNull();
    expect(await mailFor(booking.email)).toEqual([]);
    // The outbox is done with it either way: the relay handed the jobs over.
    expect(await outboxRow(booking.eventId)).toMatchObject({ status: 'PUBLISHED' });

    await broken.stop();
    const healthy = startWorker('worker#smtp-up');
    await healthy.waitFor('Worker started');
    await expectDelivered(booking, s3);

    results.smtpOutage = {
      bookingCode: booking.code,
      deadPort: dead,
      emails: (await mailFor(booking.email)).length,
      jobs: await jobCounts(),
    };
    writeFileSync(
      join(ARTIFACTS_DIR, 'd2-smtp-outage.log'),
      `${broken.text()}\n---\n${healthy.text()}`,
    );
  }, 300_000);

  // ─── D3: the object store is stopped, then replaced ───
  // Keep last: it stops the store the earlier phases used.

  it('storage that cannot be reached holds the tickets back, and they arrive once it is up', async () => {
    const booking = await paidBooking();
    await rustfs.stop();
    const blind = startWorker('worker#storage-down');

    await blind.waitFor('Worker started');
    // Notifications do not need storage, so they still arrive.
    await eventually(
      'the notification was stored',
      async () => (await notificationCount(booking.bookingId)) === 1,
    );
    await eventually('the generate-pdf job failed at least once', async () => {
      const jobs = await queue.getJobs(['failed', 'delayed', 'active']);
      return jobs.some((job) => job?.name === 'generate-pdf' && job.attemptsMade >= 1);
    });
    // No file, and therefore no email: send-email is only enqueued after a successful upload.
    expect(await emailSentAt(booking.bookingId)).toBeNull();
    expect(await mailFor(booking.email)).toEqual([]);
    await blind.stop();

    // A new store at a new address, as a restarted RustFS would be.
    const replacement = await new GenericContainer(RUSTFS_IMAGE)
      .withEnvironment({
        RUSTFS_ACCESS_KEY: ACCESS_KEY,
        RUSTFS_SECRET_KEY: SECRET_KEY,
        RUSTFS_VOLUMES: '/data',
        RUSTFS_ADDRESS: '0.0.0.0:9000',
      })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200))
      .start();
    const newEndpoint = `http://${replacement.getHost()}:${replacement.getMappedPort(9000)}`;
    const newClient = s3Client(newEndpoint);
    await newClient.send(new CreateBucketCommand({ Bucket: bucket }));
    s3Endpoint = newEndpoint;

    const healthy = startWorker('worker#storage-up');
    await healthy.waitFor('Worker started');
    await expectDelivered(booking, newClient);

    results.storageOutage = {
      bookingCode: booking.code,
      emails: (await mailFor(booking.email)).length,
      jobs: await jobCounts(),
    };
    writeFileSync(
      join(ARTIFACTS_DIR, 'd3-storage-outage.log'),
      `${blind.text()}\n---\n${healthy.text()}`,
    );
    newClient.destroy();
    await replacement.stop();
  }, 420_000);
});
