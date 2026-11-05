-- Checking queries for bookings that were paid but lost their seats (ROADMAP 3.8,
-- PLAN §5 "Xử lý NEEDS_REVIEW"). Read-only: run them by hand against any environment
-- (`psql "$DATABASE_URL" -f docs/needs-review-queries.sql`) or read them as the definition of
-- what the admin page at `/admin/review` shows.
--
-- No refund is automatic. The money goes back through the VNPay merchant portal by hand, or the
-- customer is called; `POST /admin/bookings/:id/resolve-review` only records that it was done
-- (see `audit_logs`).
--
-- Each query is preceded by a `-- name:` line; `payment-querydr`'s sibling suite
-- (`test/integration/admin-review.int-spec.ts`) reads this file, splits it on those lines and
-- runs every query against real data, so the SQL here cannot drift from what is tested.

-- name: refund-queue
-- A SUCCESS payment whose booking is not CONFIRMED: the manual queue. Every NEEDS_REVIEW booking
-- is in here, because the IPN only sends a booking to review after taking the money
-- (PLAN §5 step 6). Rows should be rare; a growing count means grace + querydr are not enough.
SELECT p.id AS payment_id, p.txn_ref, p.vnp_transaction_no, p.amount, p.processed_at,
       b.id AS booking_id, b.code, b.status AS booking_status, b.user_id,
       b.review_resolved_at, b.review_resolved_by
FROM payments p JOIN bookings b ON b.id = p.booking_id
WHERE p.status = 'SUCCESS' AND b.status <> 'CONFIRMED'
ORDER BY p.processed_at;

-- name: double-success
-- A booking with more than one SUCCESS payment. The partial unique index
-- `payments_booking_id_success_key` makes this impossible, so the result MUST be empty:
-- anything here is corrupt data, not a business case.
SELECT booking_id, count(*) AS success_count, array_agg(id) AS payment_ids
FROM payments WHERE status = 'SUCCESS'
GROUP BY booking_id HAVING count(*) > 1;

-- name: refund-required
-- A REFUND_REQUIRED payment: the booking was paid twice (two payment pages, both completed), so
-- the second payment's money has to go back. `vnp_transaction_no` is what the VNPay portal needs.
-- The booking itself is untouched and keeps the ticket bought by the first payment.
SELECT p.id AS payment_id, p.txn_ref, p.vnp_transaction_no, p.amount, p.processed_at,
       b.id AS booking_id, b.code, b.status AS booking_status, b.user_id
FROM payments p JOIN bookings b ON b.id = p.booking_id
WHERE p.status = 'REFUND_REQUIRED'
ORDER BY p.processed_at;
