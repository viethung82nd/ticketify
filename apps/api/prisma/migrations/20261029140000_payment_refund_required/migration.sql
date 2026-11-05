-- A payment VNPay reports paid while another payment of the same booking already succeeded
-- (two payment pages, both paid; added 10/2026, week 12). The booking is paid at most once
-- (payments_booking_id_success_key), so this one is recorded as REFUND_REQUIRED and refunded by
-- hand. Adding an enum value only (expand step): the previous app version never writes it.

-- AlterEnum
ALTER TYPE "payment_status" ADD VALUE 'REFUND_REQUIRED';
