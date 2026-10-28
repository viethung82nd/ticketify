# Contributing

## Branches & commits

- One task from [ROADMAP.md](ROADMAP.md) per branch: `phase-<n>/<task-id>-<slug>` (e.g. `phase-0/0.7-prisma-schema`).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and are checked by commitlint in the `commit-msg` hook.
- The `pre-commit` hook runs ESLint + Prettier on staged files (lint-staged). Never bypass hooks with `--no-verify`.

## Code rules

- No `any`, no disabling lint rules to make CI green.
- **Time**: business logic must never call `new Date()` or `Date.now()` directly. Inject `ClockService` and call `clock.now()`; tests swap in `FakeClock` to control time (hold expiry, grace period…). ESLint enforces this in `apps/api` — the only exception is the real clock implementation (`apps/api/src/infra/clock/system-clock.ts`). `new Date(value)` with an argument (parsing a known instant) is allowed.
- **Configuration**: every setting comes from environment variables validated by the zod schema in `apps/api/src/config/env.schema.ts`. Add new variables to the schema **and** to `.env.example` (a unit test fails if the two drift).
- **Database**: schema changes go through Prisma migrations. Constraints Prisma cannot express live in hand-written SQL migrations — read [apps/api/prisma/README.md](apps/api/prisma/README.md) before touching them.
- **Shared enums/schemas** live in `packages/shared`; enums must stay identical to the Prisma enums (a unit test checks this).

## Error codes

Every error body follows `ApiError` from `@ticketify/shared`, with a fixed machine-readable `code`. Two tiers:

- **Format and value limits → `400 VALIDATION_FAILED`.** Wrong type, malformed date or id, a number outside its allowed range (`rows`, `cols`, `price`, `duration`, holiday `date`/`year`, combo `price`/`name`…), too many items. Checked by the DTO (class-validator) and mirrored by the zod schema the web form uses, so client and server agree. `details` lists the fields. A showtime `startsAt` that is not after "now" is also a value limit: the service checks it against `ClockService` and answers the same `400` with `details[].field = 'startsAt'`.
- **Business rules → 404 / 409 / 422** with a specific code:
  - `404` — the resource does not exist (`ROOM_NOT_FOUND`, `PRICE_NOT_FOUND`, `SHOWTIME_NOT_FOUND`, `COMBO_NOT_FOUND`…). The public seat map also answers `SHOWTIME_NOT_FOUND` for a cancelled showtime.
  - `409` — conflict with current state (`ROOM_NAME_TAKEN`, `ROOM_IN_USE`, `ROOM_HAS_SHOWTIMES`, `HOLIDAY_EXISTS`, `SHOWTIME_OVERLAP` — recognised by the constraint name `showtimes_no_overlap`, `details.conflicts` —, `SHOWTIME_STARTED`, `SHOWTIME_HAS_BOOKINGS`, `COMBO_NAME_TAKEN`, `COMBO_IN_USE`…).
  - `422` — well-formed but breaks a rule that needs the database to check (`INVALID_COUPLE`, `COUPLE_INCONSISTENT`, `SEAT_NOT_FOUND`, `INVALID_GENRES`, `MOVIE_ENDED`), or a batch that is ambiguous as a whole: `INVALID_CHANGES` when one `seatId` appears more than once in `PATCH /admin/rooms/:id/seats` (`details.seatIds` lists them; nothing is written). (A repeated seat used to be a `400 VALIDATION_FAILED`.)

Known exception kept from week 4: `422 POSTER_NOT_UPLOADED` (and the content-type mismatch on the stored poster) — the key is well-formed but the object is missing or wrong in storage.
