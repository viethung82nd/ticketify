import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminReviewController } from './admin-review.controller';
import { AdminReviewService } from './admin-review.service';
import { PaymentRateLimiter } from './payment-rate-limiter';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { TicketCodes } from './seat-settlement';
import { VnpayService } from './vnpay/vnpay.service';

/**
 * VNPay payments (ROADMAP phase 3): creation, the return page, the IPN, and the admin queue of
 * bookings that were paid but lost their seats (3.8).
 */
@Module({
  imports: [RealtimeModule],
  controllers: [PaymentsController, AdminReviewController],
  providers: [
    PaymentService,
    VnpayService,
    RateLimitService,
    PaymentRateLimiter,
    TicketCodes,
    AdminReviewService,
  ],
  exports: [VnpayService],
})
export class PaymentsModule {}
