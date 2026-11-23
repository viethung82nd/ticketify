-- EXPLAIN (ANALYZE, BUFFERS) of the hot statements (ROADMAP 6.3), on a seeded load-test database:
--   docker exec -i ticketify-postgres-1 psql -U ticketify -d ticketify_load01 -f - \
--     < load-tests/sql/explain-hot-queries.sql > explain.txt
-- The statements copy what the API sends (Prisma's generated SQL read from the Postgres log with
-- log_min_duration_statement = 0, or the raw SQL in the services), with sample values picked here.
-- Read-only except the hold lock, which runs in a transaction that is rolled back.
\set ON_ERROR_STOP on
\pset pager off
SELECT id AS showtime FROM showtimes s
WHERE s.starts_at > now() + interval '1 day' AND s.status = 'SCHEDULED'
ORDER BY s.starts_at LIMIT 1 \gset
SELECT movie_id AS movie, room_id AS room,
       to_char(starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day
FROM showtimes WHERE id = :'showtime' \gset
-- The load user with the most bookings (the worst case of "my bookings").
SELECT user_id AS "user" FROM bookings GROUP BY user_id ORDER BY count(*) DESC LIMIT 1 \gset
\echo showtime :showtime movie :movie day :day user :user

\echo '=== 1a. Seat map, BEFORE 6.3: the 5 statements Prisma sent (showtime, movie, room, seats, showtime_seats IN 192 ids)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id, starts_at, ends_at, status::text, movie_id, room_id
  FROM showtimes WHERE (id = :'showtime' AND 1=1) LIMIT 1 OFFSET 0;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id, title, slug, duration, age_rating::text
  FROM movies WHERE id = :'movie' OFFSET 0;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id, name, rows, cols FROM rooms WHERE id = :'room' OFFSET 0;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id, row, number, type::text, is_active, couple_group, room_id
  FROM seats WHERE room_id IN (:'room') ORDER BY row ASC, number ASC OFFSET 0;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT showtime_id, seat_id, status::text, held_until, price
  FROM showtime_seats WHERE showtime_id = :'showtime'
   AND seat_id = ANY (ARRAY(SELECT id FROM seats WHERE room_id = :'room')) OFFSET 0;

\echo '=== 1b. Seat map, AFTER 6.3: one statement'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT s.id, s.starts_at, s.ends_at, s.status::text AS status,
       m.id AS movie_id, m.title, m.slug, m.duration, m.age_rating::text,
       r.id AS room_id, r.name, r.rows, r.cols,
       seat.id AS seat_id, seat.row, seat.number, seat.type::text, seat.is_active, seat.couple_group,
       ss.status::text AS ss_status, ss.held_until, ss.price
FROM showtimes s
JOIN movies m ON m.id = s.movie_id
JOIN rooms r ON r.id = s.room_id
LEFT JOIN seats seat ON seat.room_id = r.id
LEFT JOIN showtime_seats ss ON ss.showtime_id = s.id AND ss.seat_id = seat.id
WHERE s.id = :'showtime'
ORDER BY seat.row, seat.number;

\echo '=== 2. Showtimes of a movie on a day, with available/total seats (ScheduleService.listForMovie)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT s.id, s.starts_at, s.ends_at, r.id AS room_id, r.name AS room_name,
       (count(ss.seat_id) FILTER (WHERE seat.is_active AND (ss.status = 'AVAILABLE'
          OR (ss.status = 'HELD' AND ss.held_until <= now()))))::int AS available_seats,
       (count(ss.seat_id) FILTER (WHERE seat.is_active))::int AS total_seats
FROM showtimes s
JOIN rooms r ON r.id = s.room_id
LEFT JOIN showtime_seats ss ON ss.showtime_id = s.id
LEFT JOIN seats seat ON seat.id = ss.seat_id
WHERE s.movie_id = :'movie' AND s.status = 'SCHEDULED' AND s.starts_at > now()
  AND s.starts_at >= (:'day'::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
  AND s.starts_at < (:'day'::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
GROUP BY s.id, r.id
ORDER BY s.starts_at, r.name;

\echo '=== 3. Days with showtimes of a movie (datesForMovie)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT starts_at FROM showtimes
WHERE movie_id = :'movie' AND status = 'SCHEDULED' AND starts_at > now() ORDER BY starts_at ASC;

\echo '=== 4. Movie list page (count + page; genres are a second Prisma statement by movie id)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM movies WHERE status = 'NOW_SHOWING';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id, title, slug FROM movies WHERE status = 'NOW_SHOWING'
  ORDER BY release_date DESC, title ASC, id ASC LIMIT 12 OFFSET 12;

\echo '=== 5. Title search (accent-insensitive, sequential by design)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM movies
  WHERE lower(translate(title, 'ÀÁẢÃẠàáảãạ', 'AAAAAaaaaa')) LIKE '%load phim 1%' ESCAPE '\';

\echo '=== 6. My bookings, busiest user (count + first page)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM bookings WHERE user_id = :'user';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM bookings WHERE user_id = :'user'
  ORDER BY created_at DESC, id DESC LIMIT 10 OFFSET 0;

\echo '=== 7. Hold: lock the requested seats (rolled back)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT seat_id, status FROM showtime_seats
WHERE showtime_id = :'showtime'
  AND seat_id = ANY (ARRAY(SELECT id FROM seats WHERE room_id = :'room' ORDER BY id LIMIT 4))
ORDER BY seat_id FOR UPDATE NOWAIT;
ROLLBACK;

\echo '=== 8. Expiry sweep: PENDING bookings past their hold'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM bookings WHERE status = 'PENDING' AND hold_until <= now() ORDER BY hold_until LIMIT 100;

\echo '=== 9. Admin revenue, last 30 days (DashboardService.revenue)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT to_char(b.confirmed_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day,
       sum(b.total)::bigint, count(*)::int,
       sum((SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id))::int
FROM bookings b
WHERE b.status = 'CONFIRMED' AND b.confirmed_at >= now() - interval '30 days' AND b.confirmed_at < now()
GROUP BY 1;
