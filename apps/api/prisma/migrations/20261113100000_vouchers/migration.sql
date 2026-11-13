-- Vouchers (ROADMAP 5.1, PLAN §6).
--
-- Expand only: two new enums and two new tables. No existing row is read or changed, and the
-- previous application version never touches them, so this migration is safe to apply before the
-- new code is deployed.
--
-- `vouchers` holds no usage counter: how many times a voucher was used is counted from
-- `voucher_usages` (RESERVED + CONSUMED) while the voucher row is locked FOR UPDATE (5.2).
-- `voucher_usages.booking_id` is unique: a booking carries at most one voucher.
--
-- The CHECKs at the end are hand-written (Prisma's schema language cannot express them and its
-- diff ignores them, see prisma/README.md). They hold the rules the API validates too, so a row
-- written around the API still cannot be nonsense.

-- CreateEnum
CREATE TYPE "voucher_discount_type" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "voucher_usage_status" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discount_type" "voucher_discount_type" NOT NULL,
    "discount_value" INTEGER NOT NULL,
    "max_discount" INTEGER,
    "min_subtotal" INTEGER NOT NULL DEFAULT 0,
    "usage_limit" INTEGER,
    "per_user_limit" INTEGER,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_usages" (
    "id" UUID NOT NULL,
    "voucher_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "status" "voucher_usage_status" NOT NULL DEFAULT 'RESERVED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_usages_booking_id_key" ON "voucher_usages"("booking_id");

-- CreateIndex
CREATE INDEX "voucher_usages_voucher_id_status_idx" ON "voucher_usages"("voucher_id", "status");

-- CreateIndex
CREATE INDEX "voucher_usages_voucher_id_user_id_status_idx" ON "voucher_usages"("voucher_id", "user_id", "status");

-- AddForeignKey
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written CHECKs ───

-- Stored upper-case, so the plain unique index on `code` is also case-insensitive.
ALTER TABLE "vouchers"
  ADD CONSTRAINT "vouchers_code_format_check" CHECK ("code" ~ '^[A-Z0-9]{4,20}$');

-- PERCENT: 1–100, with an optional positive cap. FIXED: a positive amount and no cap.
ALTER TABLE "vouchers"
  ADD CONSTRAINT "vouchers_discount_check" CHECK (
    ("discount_type" = 'PERCENT' AND "discount_value" BETWEEN 1 AND 100
      AND ("max_discount" IS NULL OR "max_discount" > 0))
    OR ("discount_type" = 'FIXED' AND "discount_value" > 0 AND "max_discount" IS NULL)
  );

-- NULL means "no limit"; a limit of 0 would be a voucher nobody can use, so it is not allowed.
ALTER TABLE "vouchers"
  ADD CONSTRAINT "vouchers_limits_check" CHECK (
    "min_subtotal" >= 0
    AND ("usage_limit" IS NULL OR "usage_limit" > 0)
    AND ("per_user_limit" IS NULL OR "per_user_limit" > 0)
  );

ALTER TABLE "vouchers"
  ADD CONSTRAINT "vouchers_time_range_check" CHECK ("ends_at" > "starts_at");
