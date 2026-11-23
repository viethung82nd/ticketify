-- SePay bank transfer as a third payment gateway, next to VNPay and MoMo (11/2026,
-- docs/SEPAY_SETUP.md).
--
-- Expand only: one enum value, one new enum, one new table. Nothing on `payments` changes, no
-- existing row is read or written, so the previous application version keeps working against this
-- schema (it never inserts 'SEPAY' and never reads `sepay_transactions`).
--
-- `ALTER TYPE ... ADD VALUE` runs inside the migration's transaction (allowed since PostgreSQL 12)
-- as long as the new value is not used in the same transaction: nothing below mentions 'SEPAY'.
--
-- Rollback (only while no SEPAY payment exists; see docs/SEPAY_SETUP.md "Rollback"): drop the
-- table and its enum; an enum value cannot be dropped in PostgreSQL, and an unused 'SEPAY' is
-- harmless to the previous application version, so it stays.
--   DROP TABLE "sepay_transactions";
--   DROP TYPE "sepay_transaction_outcome";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261123100000_payment_provider_sepay';
-- Applying this migration again afterwards works: the enum value is only added if missing.

-- CreateEnum
CREATE TYPE "sepay_transaction_outcome" AS ENUM ('SETTLED', 'OUTGOING', 'WRONG_ACCOUNT', 'NO_REFERENCE', 'UNKNOWN_REFERENCE', 'AMOUNT_MISMATCH', 'DUPLICATE_TRANSFER');

-- AlterEnum (IF NOT EXISTS: after the rollback above the value is still there)
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'SEPAY';

-- CreateTable
CREATE TABLE "sepay_transactions" (
    "id" UUID NOT NULL,
    "sepay_id" BIGINT NOT NULL,
    "payment_id" UUID,
    "outcome" "sepay_transaction_outcome" NOT NULL,
    "transfer_type" TEXT NOT NULL,
    "transfer_amount" BIGINT NOT NULL,
    "account_number" TEXT NOT NULL,
    "sub_account" TEXT,
    "code" TEXT,
    "reference" TEXT,
    "content" TEXT,
    "reference_code" TEXT,
    "gateway" TEXT,
    "transaction_date" TEXT,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sepay_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sepay_transactions_sepay_id_key" ON "sepay_transactions"("sepay_id");

-- CreateIndex
CREATE INDEX "sepay_transactions_payment_id_idx" ON "sepay_transactions"("payment_id");

-- CreateIndex
CREATE INDEX "sepay_transactions_outcome_received_at_idx" ON "sepay_transactions"("outcome", "received_at");

-- AddForeignKey
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECKs (not modelled by Prisma, ignored by its diff; see prisma/README.md).
ALTER TABLE "sepay_transactions"
  ADD CONSTRAINT "sepay_transactions_transfer_check"
  CHECK ("transfer_type" IN ('in', 'out') AND "transfer_amount" >= 0);

ALTER TABLE "sepay_transactions"
  ADD CONSTRAINT "sepay_transactions_settled_payment_check"
  CHECK ("outcome" <> 'SETTLED' OR "payment_id" IS NOT NULL);
