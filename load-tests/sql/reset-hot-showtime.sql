-- Puts the hot showtime back to "every seat free" between two hot-showtime runs, so each run starts
-- from the same state. LOAD-TEST DATABASE ONLY (the run script refuses any other name):
--   docker exec -i ticketify-postgres-1 psql -U ticketify -d ticketify_load01 \
--     -v showtime=<hotShowtimeId> -f - < load-tests/sql/reset-hot-showtime.sql
-- Only PENDING bookings are removed (holds of the previous run); the seed gives the hot showtime
-- no sold seat, and the run never pays, so anything else there is unexpected and stops the reset.
-- The expiry jobs of the removed holds stay in Redis and end as no-ops (booking not found).
\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF current_database() NOT LIKE 'ticketify\_load%' THEN
    RAISE EXCEPTION 'not a load-test database: %', current_database();
  END IF;
END $$;
SELECT count(*) > 0 AS unexpected FROM bookings
WHERE showtime_id = :'showtime' AND status <> 'PENDING' AND status <> 'EXPIRED' \gset
\if :unexpected
  \echo 'The hot showtime has paid bookings: not resetting.'
  ROLLBACK;
  \quit
\endif
UPDATE showtime_seats SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL
WHERE showtime_id = :'showtime';
DELETE FROM bookings WHERE showtime_id = :'showtime';
COMMIT;
SELECT status, count(*) FROM showtime_seats WHERE showtime_id = :'showtime' GROUP BY status;
