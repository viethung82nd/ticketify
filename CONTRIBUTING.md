# Contributing

## Branches & commits

- One task from [ROADMAP.md](ROADMAP.md) per branch: `phase-<n>/<task-id>-<slug>` (e.g. `phase-0/0.7-prisma-schema`).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and are checked by commitlint in the `commit-msg` hook.
- The `pre-commit` hook runs ESLint + Prettier on staged files (lint-staged). Never bypass hooks with `--no-verify`.

## Code rules

- No `any`, no disabling lint rules to make CI green.
- **Time**: business logic must never call `new Date()` or `Date.now()` directly. Inject `ClockService` and call `clock.now()`; tests swap in `FakeClock` to control time (hold expiry, grace period…). ESLint enforces this in `apps/api` — the only exception is the real clock implementation (`apps/api/src/infra/clock/system-clock.ts`). `new Date(value)` with an argument (parsing a known instant) is allowed.
- **Configuration**: every setting comes from environment variables validated by the zod schema in `apps/api/src/config/env.schema.ts`. Add new variables to the schema **and** to `.env.example` (a unit test fails if the two drift).
- **Cinema time zone**: the web app shows every date and time in `DEFAULT_CINEMA_TIME_ZONE` from `packages/shared/src/cinema-time.ts`; the API reads `CINEMA_TZ` (default in `env.schema.ts`, value in `.env.example`). The two must name the same zone — change both together; `apps/api/src/config/cinema-time-zone.spec.ts` fails when they drift.
- **Database**: schema changes go through Prisma migrations. Constraints Prisma cannot express live in hand-written SQL migrations — read [apps/api/prisma/README.md](apps/api/prisma/README.md) before touching them.
- **Shared enums/schemas** live in `packages/shared`; enums must stay identical to the Prisma enums (a unit test checks this).

## Error codes

Every error body follows `ApiError` from `@ticketify/shared`, with a fixed machine-readable `code`. Two tiers:

- **Format and value limits → `400 VALIDATION_FAILED`.** Wrong type, malformed date or id, a number outside its allowed range (`rows`, `cols`, `price`, `duration`, holiday `date`/`year`, combo `price`/`name`…), too many items. Checked by the DTO (class-validator) and mirrored by the zod schema the web form uses, so client and server agree. `details` lists the fields. A showtime `startsAt` that is not after "now" is also a value limit: the service checks it against `ClockService` and answers the same `400` with `details[].field = 'startsAt'`.
- **Business rules → 404 / 409 / 422** with a specific code:
  - `404` — the resource does not exist (`ROOM_NOT_FOUND`, `PRICE_NOT_FOUND`, `SHOWTIME_NOT_FOUND`, `COMBO_NOT_FOUND`…). The public seat map also answers `SHOWTIME_NOT_FOUND` for a cancelled showtime.
  - `409` — conflict with current state (`ROOM_NAME_TAKEN`, `ROOM_IN_USE`, `ROOM_HAS_SHOWTIMES`, `HOLIDAY_EXISTS`, `SHOWTIME_OVERLAP` — recognised by the constraint name `showtimes_no_overlap`, `details.conflicts` —, `SHOWTIME_STARTED`, `SHOWTIME_HAS_BOOKINGS`, `COMBO_NAME_TAKEN`, `COMBO_IN_USE`…).
  - `422` — well-formed but breaks a rule that needs the database to check (`INVALID_COUPLE`, `COUPLE_INCONSISTENT`, `SEAT_NOT_FOUND`, `INVALID_GENRES`, `MOVIE_ENDED`), or a batch that is ambiguous as a whole: `INVALID_CHANGES` when one `seatId` appears more than once in `PATCH /admin/rooms/:id/seats` (`details.seatIds` lists them; nothing is written). (A repeated seat used to be a `400 VALIDATION_FAILED`.)

Seat holds (`POST /bookings`, phase 2) follow the same tiers: seat count (1–6), repeated seats and a missing or malformed `Idempotency-Key` header are `400 VALIDATION_FAILED`; `409 SEAT_LOCKED` (another hold has the seat locked right now — Postgres `55P03` from `FOR UPDATE NOWAIT`), `409 SEAT_UNAVAILABLE` (`details.seatIds`), `409 SHOWTIME_CANCELLED`, `409 BOOKING_ALREADY_PENDING`; `422 SEAT_NOT_FOUND`, `422 COUPLE_INCOMPLETE` (`details.missingSeatIds`), `422 COMBO_NOT_AVAILABLE` (`details.comboIds`), `422 IDEMPOTENCY_KEY_REUSED` (same key, different payload; the same key with the same payload answers `200` with the existing booking instead of `201`) and `422 SHOWTIME_STARTED`. The same code `SHOWTIME_STARTED` is a `409` when an admin cancels a started showtime (a state conflict on the admin's own action) and a `422` when a customer tries to hold seats of it.

Booking reads and limits (week 8): `GET /bookings/:id` answers `404 BOOKING_NOT_FOUND` both for an unknown id and for another user's booking — never `403`, which would confirm that the booking exists; a malformed id is `400 VALIDATION_FAILED`, like `GET /me/bookings` with an unknown `status` or a `pageSize` outside 1–50. `POST /bookings` beyond `BOOKING_RATE_LIMIT_MAX` requests per user per window is `429 TOO_MANY_ATTEMPTS` with `details.retryAfterSeconds` (the same code as the login limit).

Database pressure (week 8): a request whose interactive transaction cannot get a pool connection within its `maxWait`, or runs past its `timeout` and is rolled back by Prisma (both Prisma `P2028`), answers `503 DATABASE_BUSY` (`CommonErrorCode` in `@ticketify/shared`), never `500`: nothing was written and the client may retry. Other `P2028` errors (a query on a committed, rolled-back or unknown transaction) are bugs and stay `500`, as do deadlocks (`P2034` / `40P01`), which mean a lock order is wrong. A transaction that can wait on locks or on a busy pool sets `maxWait` and `timeout` explicitly in a named constant with the reason next to it (`HOLD_TX`, `EXPIRE_TX`, `SHOWTIME_TX`) rather than relying on Prisma's implicit defaults (2 s / 5 s), which the other transactions still use. Do not raise `DATABASE_POOL_MAX` (default 10) to hide a 5xx: find what holds the connections.

Worker transactions (week 8): every transaction the worker opens that can wait on a row lock starts with `SET LOCAL lock_timeout` (via `set_config('lock_timeout', …, true)`) set from a named constant with its reason, `WORKER_LOCK_TIMEOUT_MS` (3 s) for the booking expiry. A `55P03` there means "busy, try later", never a permanent failure: a job rethrows a plain `Error` so BullMQ retries it with the queue's backoff (never `UnrecoverableError`), the sweep counts it in `busy` and moves on. API flows that must not wait use `NOWAIT` instead and get no `lock_timeout` (`HOLD_TX`). Worker shutdown has one hard deadline, `WORKER_SHUTDOWN_GRACE_MS` (10 s) from the signal, after which `main.worker.ts` logs the running jobs and exits with code 1; keep `WORKER_LOCK_TIMEOUT_MS` well under it so a lock wait ends (and rolls back) before the deadline. Durations in this area are always named constants, never bare numbers.

Known exception kept from week 4: `422 POSTER_NOT_UPLOADED` (and the content-type mismatch on the stored poster) — the key is well-formed but the object is missing or wrong in storage.
