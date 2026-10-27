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
