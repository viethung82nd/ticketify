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
import { TicketCodes } from './seat-settlement';
import { VnpayService } from './vnpay/vnpay.service';

/**
 * Online payments: VNPay (ROADMAP phase 3) and MoMo (11/2026) — creation, the return page and the
 * IPN of each gateway, one shared way of recording a result (`settlePayment`), and the admin queue
 * of bookings that were paid but lost their seats (3.8).
 */
@Module({
  imports: [RealtimeModule],
  controllers: [PaymentsController, MomoPaymentsController, AdminReviewController],
  providers: [
    PaymentService,
    VnpayService,
    MomoClient,
    MomoPaymentService,
    RateLimitService,
    PaymentRateLimiter,
    TicketCodes,
    AdminReviewService,
  ],
  exports: [VnpayService],
})
export class PaymentsModule {}
