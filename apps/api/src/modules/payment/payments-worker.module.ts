import { Module } from '@nestjs/common';
import { TicketCodes } from './seat-settlement';
import { VnpayQuerydrClient } from './vnpay/vnpay-querydr.client';

/**
 * The payment pieces the worker process needs (ROADMAP 3.7): asking VNPay about a payment attempt
 * before expiring a booking (querydr), and drawing ticket codes when that attempt turns out to
 * have been paid. No controller and no rate limiter: the worker serves no HTTP request.
 */
@Module({
  providers: [VnpayQuerydrClient, TicketCodes],
  exports: [VnpayQuerydrClient, TicketCodes],
})
export class PaymentsWorkerModule {}
