-- Movie plot summary (added 10/2026, owner-approved). Nullable, so the previous app
-- version keeps working while this migration is applied (expand step only).

-- AlterTable
ALTER TABLE "movies" ADD COLUMN     "synopsis" TEXT;
