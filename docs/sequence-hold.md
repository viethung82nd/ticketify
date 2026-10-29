# Sequence diagrams — seat hold, expiry, cancel

How a seat hold lives and ends (PLAN §4, ROADMAP 2.1–2.16). Postgres is the only arbiter of seat
state; Redis carries jobs and realtime events, never seat state.

Lock order shared by every flow that touches seats (no flow waits on another in a cycle):

| Flow | Locks, in order |
|---|---|
| Hold `POST /bookings` | advisory lock (user, showtime) → `showtime_seats` `FOR UPDATE NOWAIT ORDER BY seat_id` |
| Expiry `expireBooking` | `bookings` `FOR UPDATE SKIP LOCKED` → its `HELD` `showtime_seats` `FOR UPDATE ORDER BY seat_id` |
| Cancel `DELETE /bookings/:id` | `bookings` `FOR UPDATE` → (reads `payments`, no lock yet) → its `HELD` `showtime_seats` `FOR UPDATE ORDER BY seat_id` |
| Payment create `POST /payments/vnpay` | `bookings` `FOR KEY SHARE` (compatible with itself, conflicts with the `FOR UPDATE` of cancel and expiry) → inserts `payments` |
| Showtime cancel (admin) | `showtimes` `FOR NO KEY UPDATE` → every `showtime_seats` of it `FOR UPDATE ORDER BY seat_id` |
| Showtime create (admin) | `rooms` `FOR NO KEY UPDATE` → `movies` `FOR SHARE` |

## Hold — `POST /bookings`

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant API as API (BookingsController / BookingService)
    participant DB as Postgres
    participant R as Redis
    participant WS as Socket.IO room showtime:{id}

    C->>API: POST /bookings + Idempotency-Key { showtimeId, seatIds, comboItems }
    API->>R: rate limit (key rl:booking:user:{userId})
    alt over BOOKING_RATE_LIMIT_MAX
        API-->>C: 429 TOO_MANY_ATTEMPTS (no DB work)
    end
    API->>DB: BEGIN (interactive transaction, READ COMMITTED)
    API->>DB: pg_advisory_xact_lock(hashtext(userId || showtimeId))
    Note over API,DB: Per (user, showtime), not a seat lock: same-key retries and the<br/>one-PENDING rule run one after the other, other users never wait here
    API->>DB: SELECT booking WHERE user_id, idempotency_key
    alt key already used
        API->>DB: COMMIT (nothing written)
        API-->>C: 200 same booking (same requestHash) or 422 IDEMPOTENCY_KEY_REUSED
    end
    API->>DB: SELECT showtime (no lock)
    API->>DB: SELECT PENDING booking of user for showtime with expires_at > now
    alt one exists
        API-->>C: 409 BOOKING_ALREADY_PENDING (ROLLBACK)
    end
    API->>DB: SELECT … FROM showtime_seats WHERE seat_id = ANY($seats)<br/>ORDER BY seat_id FOR UPDATE NOWAIT
    alt another transaction holds a seat lock (55P03)
        DB-->>API: lock_not_available
        API-->>C: 409 SEAT_LOCKED (ROLLBACK, fail fast, connection freed)
    end
    API->>DB: SELECT showtime status again (new snapshot after the seat locks)
    Note over API,DB: A showtime cancel that committed before we got the seats is visible now:<br/>409 SHOWTIME_CANCELLED / 422 SHOWTIME_STARTED
    API->>API: seats sold for this showtime (422 SEAT_NOT_FOUND), couple pairs whole<br/>(422 COUPLE_INCOMPLETE), AVAILABLE or HELD with held_until <= now (else 409 SEAT_UNAVAILABLE)
    API->>DB: INSERT bookings, booking_seats, booking_combos (prices from the showtime, combo snapshot)
    API->>DB: UPDATE showtime_seats SET HELD, booking_id, held_until = holdUntil<br/>WHERE … AND (AVAILABLE OR (HELD AND held_until <= now))
    alt rowCount ≠ number of seats
        API-->>C: 409 SEAT_UNAVAILABLE (ROLLBACK, all or nothing)
    end
    API->>DB: COMMIT
    Note over API,R: Only after the commit, and neither can fail the request (both only log)
    API->>R: BullMQ add expire-booking-{bookingId}, delay = holdUntil − now
    API->>WS: seat:held { showtimeId, seatIds, heldUntil } (Redis adapter)
    API-->>C: 201 booking PENDING (expiresAt, holdUntil)
```

## Expiry — `expire-booking` job, per-minute sweep, lazy release

```mermaid
sequenceDiagram
    autonumber
    participant Q as BullMQ (Redis)
    participant W as Worker (BookingExpiryService)
    participant DB as Postgres
    participant WS as Socket.IO (Redis emitter)
    participant H as A later hold (API)

    Note over H,DB: Lazy release: holdUntil in the DB is the deadline. Before any job runs,<br/>a hold already treats HELD seats with held_until <= now as free and points them at its booking
    alt job at holdUntil
        Q->>W: expire-booking-{bookingId}
    else sweep every minute (BullMQ job scheduler)
        Q->>W: sweep
        W->>DB: SELECT id FROM bookings WHERE PENDING AND hold_until <= now<br/>ORDER BY hold_until LIMIT 100 (no lock)
        Note over W: then the steps below for each id, one transaction each
    end
    W->>DB: BEGIN, SET LOCAL lock_timeout = 3 s
    W->>DB: SELECT booking FOR UPDATE SKIP LOCKED
    alt row locked by another flow (job vs sweep, a cancel)
        W->>DB: COMMIT
        Note over W: skipped: the other flow decides, the next sweep retries
    else not PENDING any more
        W->>DB: COMMIT
        Note over W: noop (idempotent)
    else now < holdUntil
        W->>DB: COMMIT
        W->>Q: early: moveToDelayed(holdUntil)
    else overdue
        W->>DB: UPDATE bookings SET status = EXPIRED
        W->>DB: SELECT showtime_seats WHERE booking_id = $id AND HELD<br/>ORDER BY seat_id FOR UPDATE
        W->>DB: UPDATE showtime_seats SET AVAILABLE, booking_id NULL, held_until NULL<br/>WHERE booking_id = $id AND HELD RETURNING seat_id
        Note over W,DB: booking_id = $id leaves seats a later hold already took, SOLD is never touched
        W->>DB: COMMIT
        W->>WS: seat:released { showtimeId, seatIds } (only seats really released, after commit)
    end
    opt seats locked longer than 3 s (55P03)
        W->>DB: ROLLBACK
        Note over W,Q: busy: the job is retried with backoff, the sweep counts it and moves on
    end
```

## Cancel — `DELETE /bookings/:id`

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant API as API (BookingService.cancel)
    participant DB as Postgres
    participant WS as Socket.IO room showtime:{id}

    C->>API: DELETE /bookings/:id
    API->>DB: BEGIN
    API->>DB: SELECT status, showtime_id FROM bookings<br/>WHERE id = $1 AND user_id = $2 FOR UPDATE
    Note over API,DB: Waits if an expiry holds the row (milliseconds). An expiry that comes<br/>second gets SKIP LOCKED → skipped
    alt no row (unknown, or another user's)
        API-->>C: 404 BOOKING_NOT_FOUND (ROLLBACK)
    else EXPIRED
        API->>DB: COMMIT (nothing changed)
        API-->>C: 204 (idempotent, no event)
    else CONFIRMED or NEEDS_REVIEW
        API-->>C: 409 BOOKING_NOT_CANCELLABLE (ROLLBACK)
    else PENDING
        API->>DB: SELECT status FROM payments WHERE booking_id = $1 (no lock)
        alt a SUCCESS payment
            API-->>C: 409 BOOKING_NOT_CANCELLABLE (ROLLBACK)
        else a PENDING payment
            API-->>C: 409 BOOKING_HAS_PAYMENT_IN_PROGRESS (ROLLBACK)
        end
        API->>DB: UPDATE bookings SET status = EXPIRED WHERE id = $1 AND status = PENDING
        API->>DB: SELECT showtime_seats WHERE booking_id = $1 AND HELD<br/>ORDER BY seat_id FOR UPDATE
        API->>DB: UPDATE showtime_seats SET AVAILABLE, booking_id NULL, held_until NULL<br/>WHERE booking_id = $1 AND HELD RETURNING seat_id
        API->>DB: COMMIT
        API->>WS: seat:released { showtimeId, seatIds } (after commit, only if seats changed)
        API-->>C: 204
    end
```

A cancelled booking is stored as `EXPIRED`: telling "cancelled by the user" from "ran out of time"
needs a new `BookingStatus` value (ROADMAP "Quyết định chờ"). The delayed `expire-booking` job of
a cancelled booking still runs at `holdUntil` and ends as `noop`.
