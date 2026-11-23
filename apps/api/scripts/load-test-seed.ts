/**
 * Fills a THROWAWAY load-test database with a realistic amount of data (ROADMAP 6.1) and writes
 * the file the k6 scripts read (`load-tests/.data/load-data.json`).
 *
 *   DATABASE_URL=postgresql://ticketify:ticketify@localhost:5432/ticketify_load01 \
 *   JWT_ACCESS_SECRET=<the secret the API under test runs with> \
 *   pnpm --filter @ticketify/api loadtest:seed -- --users 5000
 *
 * The database must already be migrated and seeded (`pnpm db:deploy && pnpm db:seed`, which give
 * the seat prices and genres). The script refuses any database whose name does not start with
 * `ticketify_load` and any non-local host, so it can never write into the dev database.
 *
 * What it adds (all names start with "Load"/"load-" so they are easy to tell apart):
 * - movies (most NOW_SHOWING), each linked to one or two genres;
 * - rooms "Phòng Load N" of 12 × 16 seats (rows E–H VIP, no couple seats so a k6 script can
 *   pick any seats without pairing them);
 * - five showtimes a day in every load room from `--days-back` days ago to `--days-ahead` days
 *   ahead, with their showtime seats priced like the API does (seat type × day type, holidays);
 * - users `load-user-NNNNN@load.test` (one shared argon2 hash; the password is in the README);
 * - sold history: two-seat CONFIRMED bookings with booking seats, SOLD seats, tickets and a
 *   SUCCESS payment, on a share of the past (and, fewer, of the future) showtimes, plus EXPIRED
 *   bookings like abandoned holds leave behind;
 * - one "hot" showtime tomorrow evening with every seat AVAILABLE.
 *
 * Ids are UUIDv7 stamped with each row's creation time, like Prisma's `uuid(7)` default, so the
 * primary-key indexes have the same locality as a production database.
 *
 * Access tokens are signed here with JWT_ACCESS_SECRET instead of logging every user in: login is
 * rate limited per IP (LOGIN_RATE_LIMIT_MAX × 4 per window) and is not what the load test measures.
 */
import { hash } from '@node-rs/argon2';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sign } from 'jsonwebtoken';
import { Client } from 'pg';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOAD_DB_PREFIX = 'ticketify_load';
/** Shared by every load user; only ever valid in a throwaway load-test database. */
export const LOAD_USER_PASSWORD = 'load-test-password';

/** Local start times of the five daily shows: 3 h 15 apart, longer than any film + cleaning. */
const SLOTS = ['09:00', '12:15', '15:30', '18:45', '22:00'];
const HOT_SLOT = '18:45';
const ROOM_ROWS = 12;
const ROOM_COLS = 16;
const VIP_ROWS = ['E', 'F', 'G', 'H'];

interface Options {
  users: number;
  movies: number;
  rooms: number;
  daysBack: number;
  daysAhead: number;
  /** Share of seat pairs sold on a past showtime (0–1). */
  pastFill: number;
  /** Share of seat pairs already sold on a future showtime (0–1); the hot showtime stays empty. */
  futureFill: number;
  tokenTtlHours: number;
  out: string;
}

const DEFAULTS: Options = {
  users: 5000,
  movies: 60,
  rooms: 8,
  daysBack: 60,
  daysAhead: 14,
  pastFill: 0.45,
  futureFill: 0.15,
  tokenTtlHours: 8,
  out: resolve(__dirname, '../../../load-tests/.data/load-data.json'),
};

function parseArgs(argv: string[]): Options {
  const options = { ...DEFAULTS };
  const numeric: Record<string, keyof Omit<Options, 'out'>> = {
    '--users': 'users',
    '--movies': 'movies',
    '--rooms': 'rooms',
    '--days-back': 'daysBack',
    '--days-ahead': 'daysAhead',
    '--past-fill': 'pastFill',
    '--future-fill': 'futureFill',
    '--token-ttl-hours': 'tokenTtlHours',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '--out') {
      options.out = resolve(argv[++i] ?? '');
      continue;
    }
    const key = numeric[arg];
    const value = Number(argv[++i]);
    if (!key || !Number.isFinite(value) || value < 0) throw new Error(`Bad argument: ${arg}`);
    options[key] = value;
  }
  if (options.pastFill > 1 || options.futureFill > 1) throw new Error('Fill shares are 0–1');
  if (options.users < 1 || options.movies < 2 || options.rooms < 1) {
    throw new Error('Need at least 1 user, 2 movies and 1 room');
  }
  return options;
}

function checkTarget(url: string): void {
  const parsed = new URL(url);
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to seed a non-local database (${parsed.hostname})`);
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!name.startsWith(LOAD_DB_PREFIX)) {
    throw new Error(
      `Refusing to seed "${name}": the database name must start with ${LOAD_DB_PREFIX}`,
    );
  }
}

/**
 * UUIDv7 for a given instant, in SQL: the 48-bit Unix-millisecond prefix over a random v4 UUID,
 * version nibble turned from 4 into 7 by setting bits 52 and 53. Session-local (pg_temp).
 */
const UUID7_FUNCTION = `
  CREATE FUNCTION pg_temp.uuid7(ts timestamptz) RETURNS uuid LANGUAGE sql VOLATILE AS $$
    SELECT encode(
      set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
        PLACING substring(int8send(floor(extract(epoch FROM ts) * 1000)::bigint) FROM 3)
        FROM 1 FOR 6), 52, 1), 53, 1),
      'hex')::uuid
  $$`;

async function step(db: Client, label: string, sql: string, params: unknown[] = []): Promise<void> {
  const started = performance.now();
  const result = await db.query(sql, params);
  const ms = Math.round(performance.now() - started);
  console.log(`  ${label}: ${result.rowCount ?? 0} rows (${ms} ms)`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  const secret = process.env.JWT_ACCESS_SECRET;
  const tz = process.env.CINEMA_TZ ?? 'Asia/Ho_Chi_Minh';
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not set (use the API under test’s secret)');
  checkTarget(url);

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows: ready } = await db.query<{ prices: number; genres: number; rooms: number }>(`
      SELECT (SELECT count(*)::int FROM seat_prices) AS prices,
             (SELECT count(*)::int FROM genres) AS genres,
             (SELECT count(*)::int FROM rooms WHERE name LIKE 'Phòng Load %') AS rooms`);
    if (ready[0]!.prices < 9 || ready[0]!.genres < 1) {
      throw new Error('Run `pnpm db:deploy && pnpm db:seed` on this database first');
    }
    if (ready[0]!.rooms > 0) throw new Error('This database is already seeded for load tests');

    await db.query(UUID7_FUNCTION);
    await db.query(`SET TIME ZONE 'UTC'`);
    const passwordHash = await hash(LOAD_USER_PASSWORD);
    console.log(`Seeding ${new URL(url).pathname.slice(1)} (cinema time zone ${tz})`);

    await db.query('BEGIN');
    const nowShowing = Math.max(2, Math.round(options.movies * 0.7));
    await step(
      db,
      'movies',
      `INSERT INTO movies (id, title, slug, synopsis, duration, age_rating, release_date, status,
                           created_at, updated_at)
       SELECT pg_temp.uuid7(now() - (i || ' days')::interval),
              format('Load Phim %s', lpad(i::text, 3, '0')),
              format('load-phim-%s', lpad(i::text, 3, '0')),
              'Phim sinh tự động cho load test.',
              90 + (i * 7) % 61,
              (ARRAY['P','K','T13','T16','T18'])[1 + i % 5]::age_rating,
              current_date - (i % 120),
              (CASE WHEN i <= $2 THEN 'NOW_SHOWING' ELSE 'COMING_SOON' END)::movie_status,
              now() - (i || ' days')::interval, now()
       FROM generate_series(1, $1) AS i`,
      [options.movies, nowShowing],
    );
    await step(
      db,
      'movie genres',
      `INSERT INTO movie_genres (movie_id, genre_id)
       SELECT DISTINCT m.id, g.id
       FROM (SELECT id, row_number() OVER (ORDER BY slug) AS n FROM movies
             WHERE slug LIKE 'load-phim-%') m
       CROSS JOIN LATERAL (VALUES (m.n), (m.n * 3 + 1)) AS pick(k)
       JOIN (SELECT id, row_number() OVER (ORDER BY slug) - 1 AS n, count(*) OVER () AS total
             FROM genres) g ON g.n = pick.k % g.total`,
    );
    await step(
      db,
      'rooms',
      `INSERT INTO rooms (id, name, rows, cols, created_at, updated_at)
       SELECT pg_temp.uuid7(now() - interval '200 days'), format('Phòng Load %s', r), $2, $3,
              now() - interval '200 days', now()
       FROM generate_series(1, $1) AS r`,
      [options.rooms, ROOM_ROWS, ROOM_COLS],
    );
    await step(
      db,
      'seats',
      `INSERT INTO seats (id, room_id, row, number, type, created_at, updated_at)
       SELECT pg_temp.uuid7(r.created_at), r.id, chr(64 + rw), n,
              (CASE WHEN chr(64 + rw) = ANY($1) THEN 'VIP' ELSE 'STANDARD' END)::seat_type,
              r.created_at, now()
       FROM rooms r, generate_series(1, r.rows) AS rw, generate_series(1, r.cols) AS n
       WHERE r.name LIKE 'Phòng Load %'`,
      [VIP_ROWS],
    );
    // Day d, room r, slot k: a film chosen by a stride so neighbours differ; ends = start +
    // duration + 15 min cleaning (SHOWTIME_CLEANUP_MINUTES), never past the next slot.
    await step(
      db,
      'showtimes',
      `WITH films AS (
         SELECT id, duration, row_number() OVER (ORDER BY slug) - 1 AS n, count(*) OVER () AS total
         FROM movies WHERE slug LIKE 'load-phim-%' AND status = 'NOW_SHOWING'),
       rooms_n AS (
         SELECT id, row_number() OVER (ORDER BY name) - 1 AS n FROM rooms
         WHERE name LIKE 'Phòng Load %'),
       today AS (SELECT (now() AT TIME ZONE $1)::date AS d),
       slots AS (
         SELECT ((today.d + day) + slot::time) AT TIME ZONE $1 AS starts_at, day, k
         FROM today, generate_series(-$2::int, $3::int) AS day,
              unnest($4::text[]) WITH ORDINALITY AS s(slot, k))
       INSERT INTO showtimes (id, movie_id, room_id, starts_at, ends_at, status, created_at,
                              updated_at)
       SELECT pg_temp.uuid7(LEAST(now(), s.starts_at - interval '14 days')), f.id, r.id,
              s.starts_at, s.starts_at + make_interval(mins => f.duration + 15), 'SCHEDULED',
              LEAST(now(), s.starts_at - interval '14 days'), now()
       FROM slots s CROSS JOIN rooms_n r
       JOIN films f ON f.n = ((s.day + 1000) * 37 + r.n * 11 + s.k * 5) % f.total`,
      [tz, options.daysBack, options.daysAhead, SLOTS],
    );
    // The price the API snapshots: seat type × day type of the cinema-local show date.
    await step(
      db,
      'showtime seats',
      `INSERT INTO showtime_seats (showtime_id, seat_id, status, price)
       SELECT st.id, s.id, 'AVAILABLE', sp.price
       FROM showtimes st
       JOIN rooms r ON r.id = st.room_id AND r.name LIKE 'Phòng Load %'
       JOIN seats s ON s.room_id = r.id
       CROSS JOIN LATERAL (SELECT (st.starts_at AT TIME ZONE $1)::date AS local_day) d
       JOIN seat_prices sp ON sp.seat_type = s.type AND sp.day_type = (CASE
         WHEN EXISTS (SELECT 1 FROM holidays h WHERE h.date = d.local_day) THEN 'HOLIDAY'
         WHEN extract(isodow FROM d.local_day) IN (6, 7) THEN 'WEEKEND'
         ELSE 'WEEKDAY' END)::day_type`,
      [tz],
    );
    await step(
      db,
      'users',
      `INSERT INTO users (id, email, password_hash, full_name, role, created_at, updated_at)
       SELECT pg_temp.uuid7(c), format('load-user-%s@load.test', lpad(i::text, 5, '0')), $2,
              format('Khách Load %s', lpad(i::text, 5, '0')), 'USER', c, c
       FROM generate_series(1, $1) AS i,
            LATERAL (SELECT now() - interval '300 days' * random() AS c) t`,
      [options.users, passwordHash],
    );

    const { rows: hot } = await db.query<{ id: string; starts_at: Date }>(
      `SELECT st.id, st.starts_at FROM showtimes st JOIN rooms r ON r.id = st.room_id
       WHERE r.name = 'Phòng Load 1'
         AND st.starts_at = (((now() AT TIME ZONE $1)::date + 1) + $2::time) AT TIME ZONE $1`,
      [tz, HOT_SLOT],
    );
    const hotShowtimeId = hot[0]?.id;
    if (!hotShowtimeId) throw new Error('Hot showtime not found');

    // Sold history, two adjacent seats per booking. A pair is sold with probability pastFill on a
    // past show and futureFill on a future one (never on the hot one). Created up to a week
    // before the show, never in the future.
    await step(
      db,
      'sold pairs (temp)',
      `CREATE TEMP TABLE seed_pairs AS
       SELECT st.id AS showtime_id, s1.id AS seat1, s2.id AS seat2,
              ss1.price + ss2.price AS total, c.created_at,
              pg_temp.uuid7(c.created_at) AS booking_id,
              1 + floor(random() * $3)::int AS user_n,
              row_number() OVER () AS n,
              st.starts_at < now() AS past
       FROM showtimes st
       JOIN rooms r ON r.id = st.room_id AND r.name LIKE 'Phòng Load %'
       JOIN seats s1 ON s1.room_id = r.id AND s1.number % 2 = 1
       JOIN seats s2 ON s2.room_id = r.id AND s2.row = s1.row AND s2.number = s1.number + 1
       JOIN showtime_seats ss1 ON ss1.showtime_id = st.id AND ss1.seat_id = s1.id
       JOIN showtime_seats ss2 ON ss2.showtime_id = st.id AND ss2.seat_id = s2.id
       CROSS JOIN LATERAL (SELECT LEAST(now() - interval '1 minute',
         st.starts_at - interval '1 hour' - interval '7 days' * random()) AS created_at) c
       WHERE st.id <> $4
         AND random() < (CASE WHEN st.starts_at < now() THEN $1 ELSE $2 END)::float8`,
      [options.pastFill, options.futureFill, options.users, hotShowtimeId],
    );
    await db.query(`
      CREATE TEMP TABLE seed_users AS
      SELECT id, row_number() OVER (ORDER BY email)::int AS n FROM users
      WHERE email LIKE 'load-user-%@load.test'`);
    await step(
      db,
      'confirmed bookings',
      `INSERT INTO bookings (id, code, user_id, showtime_id, status, subtotal, discount, total,
                             expires_at, hold_until, idempotency_key, request_hash, confirmed_at,
                             email_sent_at, created_at, updated_at)
       SELECT p.booking_id, upper(substr(md5(p.booking_id::text), 1, 10)), u.id, p.showtime_id,
              'CONFIRMED', p.total, 0, p.total,
              p.created_at + interval '15 minutes', p.created_at + interval '10 minutes',
              'load-' || p.booking_id, md5(p.booking_id::text),
              p.created_at + interval '3 minutes', p.created_at + interval '4 minutes',
              p.created_at, p.created_at + interval '4 minutes'
       FROM seed_pairs p JOIN seed_users u ON u.n = p.user_n`,
    );
    await step(
      db,
      'booking seats',
      `INSERT INTO booking_seats (id, booking_id, showtime_id, seat_id, price)
       SELECT pg_temp.uuid7(p.created_at), p.booking_id, p.showtime_id, x.seat_id, ss.price
       FROM seed_pairs p CROSS JOIN LATERAL (VALUES (p.seat1), (p.seat2)) AS x(seat_id)
       JOIN showtime_seats ss ON ss.showtime_id = p.showtime_id AND ss.seat_id = x.seat_id`,
    );
    await step(
      db,
      'sold seats',
      `UPDATE showtime_seats ss SET status = 'SOLD', booking_id = bs.booking_id
       FROM booking_seats bs JOIN seed_pairs p ON p.booking_id = bs.booking_id
       WHERE ss.showtime_id = bs.showtime_id AND ss.seat_id = bs.seat_id`,
    );
    // Past shows: about a third of the tickets were scanned at the door.
    await step(
      db,
      'tickets',
      `INSERT INTO tickets (id, booking_id, showtime_id, seat_id, code, status, created_at,
                            updated_at)
       SELECT pg_temp.uuid7(p.created_at), p.booking_id, p.showtime_id, x.seat_id,
              'L' || lpad((p.n * 2 + x.k)::text, 11, '0'),
              (CASE WHEN p.past AND random() < 0.33 THEN 'CHECKED_IN' ELSE 'ISSUED' END)
                ::ticket_status,
              p.created_at + interval '3 minutes', p.created_at + interval '3 minutes'
       FROM seed_pairs p CROSS JOIN LATERAL (VALUES (p.seat1, 0), (p.seat2, 1)) AS x(seat_id, k)`,
    );
    await step(
      db,
      'payments',
      `INSERT INTO payments (id, booking_id, provider, txn_ref, amount, status, vnp_transaction_no,
                             provider_transaction_id, bank_code, response_code, processed_at,
                             created_at, updated_at)
       SELECT pg_temp.uuid7(p.created_at + interval '1 minute'), p.booking_id, 'VNPAY',
              'LOAD' || lpad(p.n::text, 12, '0'), p.total, 'SUCCESS',
              lpad(p.n::text, 12, '0'), lpad(p.n::text, 12, '0'), 'NCB', '00',
              p.created_at + interval '3 minutes', p.created_at + interval '1 minute',
              p.created_at + interval '3 minutes'
       FROM seed_pairs p`,
    );
    // Abandoned holds: half as many EXPIRED bookings, with the seats they had asked for.
    await step(
      db,
      'expired bookings (their seat lines)',
      `WITH picked AS (
         SELECT p.*, pg_temp.uuid7(p.created_at - interval '1 hour') AS expired_id,
                1 + floor(random() * $1)::int AS other_user
         FROM seed_pairs p WHERE p.n % 2 = 0),
       b AS (
         INSERT INTO bookings (id, code, user_id, showtime_id, status, subtotal, discount, total,
                               expires_at, hold_until, idempotency_key, request_hash, created_at,
                               updated_at)
         SELECT k.expired_id, upper(substr(md5(k.expired_id::text), 1, 10)), u.id, k.showtime_id,
                'EXPIRED', k.total, 0, k.total,
                k.created_at - interval '45 minutes', k.created_at - interval '50 minutes',
                'load-' || k.expired_id, md5(k.expired_id::text),
                k.created_at - interval '1 hour', k.created_at - interval '45 minutes'
         FROM picked k JOIN seed_users u ON u.n = k.other_user
         RETURNING id)
       INSERT INTO booking_seats (id, booking_id, showtime_id, seat_id, price)
       SELECT pg_temp.uuid7(k.created_at - interval '1 hour'), k.expired_id, k.showtime_id,
              x.seat_id, k.total / 2
       FROM picked k CROSS JOIN LATERAL (VALUES (k.seat1), (k.seat2)) AS x(seat_id)
       WHERE k.expired_id IN (SELECT id FROM b)`,
      [options.users],
    );
    await db.query('COMMIT');
    await db.query('ANALYZE');

    const { rows: dbNow } = await db.query<{ now: Date }>('SELECT now() AS now');
    const iat = Math.floor(dbNow[0]!.now.getTime() / 1000);
    const exp = iat + Math.round(options.tokenTtlHours * 3600);
    const { rows: users } = await db.query<{ id: string }>('SELECT id FROM seed_users ORDER BY n');
    const { rows: movies } = await db.query<{ id: string; slug: string; status: string }>(
      `SELECT id, slug, status::text FROM movies ORDER BY slug`,
    );
    const { rows: future } = await db.query<{ id: string; movie_id: string; day: string }>(
      `SELECT st.id, st.movie_id, to_char(st.starts_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day
       FROM showtimes st JOIN rooms r ON r.id = st.room_id AND r.name LIKE 'Phòng Load %'
       WHERE st.starts_at > now() + interval '1 hour' AND st.id <> $2 ORDER BY st.starts_at`,
      [tz, hotShowtimeId],
    );
    const data = {
      generatedAt: dbNow[0]!.now.toISOString(),
      tokenExpiresAt: new Date(exp * 1000).toISOString(),
      cinemaTimeZone: tz,
      hotShowtimeId,
      hotShowtimeStartsAt: hot[0]!.starts_at.toISOString(),
      movies,
      futureShowtimes: future.map((row) => ({ id: row.id, movieId: row.movie_id, day: row.day })),
      users: users.map((user) => ({
        id: user.id,
        token: sign({ sub: user.id, role: 'USER', iat, exp }, secret, { algorithm: 'HS256' }),
      })),
    };
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, JSON.stringify(data));

    const { rows: counts } = await db.query<Record<string, string>>(`
      SELECT (SELECT count(*) FROM movies) AS movies, (SELECT count(*) FROM rooms) AS rooms,
             (SELECT count(*) FROM seats) AS seats, (SELECT count(*) FROM showtimes) AS showtimes,
             (SELECT count(*) FROM showtime_seats) AS showtime_seats,
             (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM bookings) AS bookings,
             (SELECT count(*) FROM booking_seats) AS booking_seats,
             (SELECT count(*) FROM tickets) AS tickets, (SELECT count(*) FROM payments) AS payments,
             pg_size_pretty(pg_database_size(current_database())) AS database_size`);
    console.log('Done:', counts[0]);
    console.log(`Hot showtime ${hotShowtimeId} at ${data.hotShowtimeStartsAt}`);
    console.log(
      `k6 data (${users.length} tokens, valid until ${data.tokenExpiresAt}): ${options.out}`,
    );
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
