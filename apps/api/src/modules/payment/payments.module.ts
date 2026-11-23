import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminReviewController } from './admin-review.controller';
import { AdminReviewService } from './admin-review.service';
import { MomoClient } from './momo/momo.client';
import { MomoPaymentService } from './momo/momo-payment.service';
import { MomoPaymentsController } from './momo/momo-payments.controller';
import { PaymentRateLimiter } from './payment-rate-limiter';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { SepayConfig } from './sepay/sepay.config';
import { SepayPaymentService } from './sepay/sepay-payment.service';
import { SepayPaymentsController } from './sepay/sepay-payments.controller';
import { TicketCodes } from './seat-settlement';
import { VnpayService } from './vnpay/vnpay.service';

/**
 * Online payments: VNPay (ROADMAP phase 3), MoMo (11/2026) and SePay bank transfer (11/2026) —
 * creation, the return page (VNPay, MoMo), the IPN or webhook of each gateway, one shared way of recording a result (`settlePayment`), and the admin queue
 * of bookings that were paid but lost their seats (3.8).
 */
@Module({
  imports: [RealtimeModule],
  controllers: [
    PaymentsController,
    MomoPaymentsController,
    SepayPaymentsController,
    AdminReviewController,
  ],
  providers: [
    PaymentService,
    VnpayService,
    MomoClient,
    MomoPaymentService,
    SepayConfig,
    SepayPaymentService,
    RateLimitService,
    PaymentRateLimiter,
    TicketCodes,
    AdminReviewService,
  ],
  exports: [VnpayService],
})
export class PaymentsModule {}
