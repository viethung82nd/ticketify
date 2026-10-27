-- Hand-written migration: constraints Prisma's schema language cannot express.
-- See prisma/README.md before editing. Never edit this file after it has been applied
-- anywhere; add a new migration instead.

-- ─────────────────────────────────────────────────────────────────────────────
-- Showtime: no two non-cancelled showtimes may overlap in the same room.
-- ─────────────────────────────────────────────────────────────────────────────
-- btree_gist lets a GiST index combine equality on room_id with range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A showtime must have a positive duration (an empty range would never overlap).
ALTER TABLE "showtimes"
  ADD CONSTRAINT "showtimes_time_range_check" CHECK ("ends_at" > "starts_at");

-- Half-open range [starts_at, ends_at): a showtime may start exactly when the
-- previous one in the same room ends.
ALTER TABLE "showtimes"
  ADD CONSTRAINT "showtimes_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" <> 'CANCELLED');

-- ─────────────────────────────────────────────────────────────────────────────
-- ShowtimeSeat: status must agree with booking_id / held_until.
-- One constraint per status so a violation names the broken rule.
-- ─────────────────────────────────────────────────────────────────────────────
-- AVAILABLE ⇒ no booking owns the seat.
ALTER TABLE "showtime_seats"
  ADD CONSTRAINT "showtime_seats_available_check"
  CHECK ("status" <> 'AVAILABLE' OR "booking_id" IS NULL);

-- HELD ⇒ owned by a booking and has an expiry (lazy expiry compares held_until to now()).
ALTER TABLE "showtime_seats"
  ADD CONSTRAINT "showtime_seats_held_check"
  CHECK ("status" <> 'HELD' OR ("booking_id" IS NOT NULL AND "held_until" IS NOT NULL));

-- SOLD ⇒ owned by the booking that paid for it, so every sold seat can be traced
-- to its booking/tickets (NEEDS_REVIEW reconciliation, audits).
ALTER TABLE "showtime_seats"
  ADD CONSTRAINT "showtime_seats_sold_check"
  CHECK ("status" <> 'SOLD' OR "booking_id" IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Partial unique indexes.
-- ─────────────────────────────────────────────────────────────────────────────
-- Last line of defence against double-selling: one live ticket per seat per showtime.
CREATE UNIQUE INDEX "tickets_showtime_id_seat_id_live_key"
  ON "tickets" ("showtime_id", "seat_id")
  WHERE "status" <> 'VOID';

-- A booking can be paid successfully at most once (other attempts may fail/expire).
CREATE UNIQUE INDEX "payments_booking_id_success_key"
  ON "payments" ("booking_id")
  WHERE "status" = 'SUCCESS';

-- Note: payments.vnp_transaction_no keeps the plain UNIQUE index created by Prisma.
-- Postgres treats NULLs as distinct (default NULLS DISTINCT), so any number of
-- attempts without a transaction number can coexist.
