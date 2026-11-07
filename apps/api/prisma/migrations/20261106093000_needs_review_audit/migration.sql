-- Admin handling of NEEDS_REVIEW bookings (ROADMAP 3.8, PLAN §5 "Xử lý NEEDS_REVIEW").
--
-- Expand only: one new table and two nullable columns. No existing row is read or changed, and
-- the previous application version never writes either, so this migration is safe to apply
-- before the new code is deployed.
--
-- `bookings.review_resolved_at` / `review_resolved_by` hold the current state ("an admin has
-- handled this"); `audit_logs` is the append-only history of every such action, with the note the
-- admin wrote and the state before and after. A booking's `status` is NOT changed by marking it
-- handled: it stays NEEDS_REVIEW (adding a BookingStatus value is a separate decision, see
-- ROADMAP "Quyết định chờ"). Refunds are made by hand outside the system.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "review_resolved_at" TIMESTAMPTZ(3),
ADD COLUMN     "review_resolved_by" UUID;

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "note" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_review_resolved_by_fkey" FOREIGN KEY ("review_resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
