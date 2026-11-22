-- MoMo as a second payment gateway, next to VNPay (11/2026).
--
-- Expand only: one new enum and four new nullable-or-defaulted columns on `payments`. No column
-- is dropped or renamed, so the previous application version keeps working against this schema:
-- it never reads the new columns, and every row it inserts gets `provider = 'VNPAY'` from the
-- default. Adding a column with a constant default does not rewrite the table (Postgres 11+).
--
-- `provider_transaction_id` is the gateway's own transaction id for both providers. The only
-- statement that reads existing data copies `vnp_transaction_no` into it for the VNPay rows that
-- have one, so the new column is complete from the start; `vnp_transaction_no` itself is kept
-- (admin screens, outbox payloads and refunds still read it for VNPay).
--
-- The two CHECKs at the end are hand-written (see prisma/README.md): a MoMo attempt always has the
-- requestId it was created with, and only a VNPay row can carry a VNPay transaction number.

-- CreateEnum
CREATE TYPE "payment_provider" AS ENUM ('VNPAY', 'MOMO');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "pay_url" TEXT,
ADD COLUMN     "provider" "payment_provider" NOT NULL DEFAULT 'VNPAY',
ADD COLUMN     "provider_request_id" TEXT,
ADD COLUMN     "provider_transaction_id" TEXT;

-- Backfill (data-preserving): the VNPay transaction numbers already recorded.
UPDATE "payments"
SET "provider_transaction_id" = "vnp_transaction_no"
WHERE "vnp_transaction_no" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_request_id_key" ON "payments"("provider_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_transaction_id_key" ON "payments"("provider", "provider_transaction_id");

-- Hand-written CHECKs (not modelled by Prisma, ignored by its diff).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_momo_request_id_check"
  CHECK ("provider" <> 'MOMO' OR "provider_request_id" IS NOT NULL);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_vnp_transaction_no_provider_check"
  CHECK ("vnp_transaction_no" IS NULL OR "provider" = 'VNPAY');
