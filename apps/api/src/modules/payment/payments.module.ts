import { Module } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { PaymentRateLimiter } from './payment-rate-limiter';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { VnpayService } from './vnpay/vnpay.service';

/** VNPay payments (ROADMAP phase 3): creation and the return page. The IPN comes in 3.4. */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentService, VnpayService, RateLimitService, PaymentRateLimiter],
  exports: [VnpayService],
})
export class PaymentsModule {}
