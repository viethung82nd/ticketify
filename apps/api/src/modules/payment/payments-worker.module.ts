import { Module } from '@nestjs/common';
import { MomoClient } from './momo/momo.client';
import { TicketCodes } from './seat-settlement';
import { VnpayQuerydrClient } from './vnpay/vnpay-querydr.client';

/**
 * The payment pieces the worker process needs (ROADMAP 3.7): asking the gateway about a payment
 * attempt before expiring a booking (VNPay querydr, MoMo query), and drawing ticket codes when that
 * attempt turns out to have been paid. No controller and no rate limiter: the worker serves no HTTP request.
 */
@Module({
  providers: [VnpayQuerydrClient, MomoClient, TicketCodes],
  exports: [VnpayQuerydrClient, MomoClient, TicketCodes],
})
export class PaymentsWorkerModule {}
