import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { PaymentRateLimiter } from './payment-rate-limiter';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { TicketCodes } from './seat-settlement';
import { VnpayService } from './vnpay/vnpay.service';

/** VNPay payments (ROADMAP phase 3): creation, the return page and the IPN. */
@Module({
  imports: [RealtimeModule],
  controllers: [PaymentsController],
  providers: [PaymentService, VnpayService, RateLimitService, PaymentRateLimiter, TicketCodes],
  exports: [VnpayService],
})
export class PaymentsModule {}
