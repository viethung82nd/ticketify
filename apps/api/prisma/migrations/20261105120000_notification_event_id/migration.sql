-- Expand-only: one nullable column and one partial unique index. No existing row changes.
--
-- The worker delivers each outbox event at least once (ROADMAP 4.1), so the `notify` step may run
-- again after a crash or a lost acknowledgement. `event_id` is the outbox event the notification
-- came from; the index below lets the insert say ON CONFLICT DO NOTHING, which makes a second run
-- store nothing and send nothing instead of showing the user the same line twice.
--
-- Nullable and a PARTIAL index on purpose: a notification created by hand (an admin tool, a
-- future broadcast) has no event, and several of those per user must stay possible.
ALTER TABLE "notifications" ADD COLUMN "event_id" UUID;

CREATE UNIQUE INDEX "notifications_user_id_event_id_key"
  ON "notifications" ("user_id", "event_id")
  WHERE "event_id" IS NOT NULL;
