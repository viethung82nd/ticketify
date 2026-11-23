-- Run after EVERY load-test run (ROADMAP 6.2) against the load-test database:
--   docker exec -i ticketify-postgres-1 psql -U ticketify -d ticketify_loadNN -f - < load-tests/sql/verify-no-duplicates.sql
-- One row per rule with the number of offending rows. Every count must be 0; any other value
-- means a seat or ticket was sold/held twice (or a hold was left half-done) and the run is a
-- correctness failure, not a performance result.
--
-- "Live" booking = CONFIRMED or NEEDS_REVIEW, or PENDING whose hold has not run out. A PENDING
-- booking past hold_until is over even before the worker marks it EXPIRED (lazy expiry), and
-- another booking may already have taken its seats: that is not a duplicate.
WITH live AS (
  SELECT id, status FROM bookings
  WHERE status IN ('CONFIRMED', 'NEEDS_REVIEW')
     OR (status = 'PENDING' AND hold_until > now())
),
checks AS (
  -- Two live tickets on one seat of one showtime (the partial unique index forbids it).
  SELECT 'duplicate_live_tickets' AS rule, count(*) AS violations FROM (
    SELECT showtime_id, seat_id FROM tickets WHERE status <> 'VOID'
    GROUP BY showtime_id, seat_id HAVING count(*) > 1) t
  UNION ALL
  -- One seat in the booking_seats of two live bookings.
  SELECT 'seat_in_two_live_bookings', count(*) FROM (
    SELECT bs.showtime_id, bs.seat_id FROM booking_seats bs JOIN live l ON l.id = bs.booking_id
    GROUP BY bs.showtime_id, bs.seat_id HAVING count(*) > 1) t
  UNION ALL
  -- A live PENDING booking that does not hold every one of its seats (all-or-nothing broken).
  SELECT 'pending_hold_incomplete', count(*) FROM (
    SELECT bs.booking_id FROM booking_seats bs
    JOIN bookings b ON b.id = bs.booking_id AND b.status = 'PENDING' AND b.hold_until > now()
    LEFT JOIN showtime_seats ss ON ss.showtime_id = bs.showtime_id AND ss.seat_id = bs.seat_id
      AND ss.status = 'HELD' AND ss.booking_id = bs.booking_id
    WHERE ss.seat_id IS NULL GROUP BY bs.booking_id) t
  UNION ALL
  -- A CONFIRMED booking that does not own every one of its seats, SOLD.
  SELECT 'confirmed_not_sold', count(*) FROM (
    SELECT bs.booking_id FROM booking_seats bs
    JOIN bookings b ON b.id = bs.booking_id AND b.status = 'CONFIRMED'
    LEFT JOIN showtime_seats ss ON ss.showtime_id = bs.showtime_id AND ss.seat_id = bs.seat_id
      AND ss.status = 'SOLD' AND ss.booking_id = bs.booking_id
    WHERE ss.seat_id IS NULL GROUP BY bs.booking_id) t
  UNION ALL
  -- A HELD or SOLD seat whose owner booking does not list that seat.
  SELECT 'owner_without_line', count(*) FROM showtime_seats ss
  WHERE ss.status IN ('HELD', 'SOLD') AND NOT EXISTS (
    SELECT 1 FROM booking_seats bs WHERE bs.booking_id = ss.booking_id
      AND bs.showtime_id = ss.showtime_id AND bs.seat_id = ss.seat_id)
  UNION ALL
  -- A seat still HELD by a booking that is over (EXPIRED, CONFIRMED, NEEDS_REVIEW).
  SELECT 'held_by_finished_booking', count(*) FROM showtime_seats ss
  JOIN bookings b ON b.id = ss.booking_id
  WHERE ss.status = 'HELD' AND b.status <> 'PENDING'
  UNION ALL
  -- A SOLD seat whose booking is not CONFIRMED / NEEDS_REVIEW.
  SELECT 'sold_without_paid_booking', count(*) FROM showtime_seats ss
  JOIN bookings b ON b.id = ss.booking_id
  WHERE ss.status = 'SOLD' AND b.status NOT IN ('CONFIRMED', 'NEEDS_REVIEW')
)
SELECT rule, violations FROM checks
UNION ALL
-- Not a rule: deadlocks Postgres detected in this database since its statistics were reset.
SELECT 'info_deadlocks_detected', deadlocks FROM pg_stat_database WHERE datname = current_database();
