import { Body, Controller, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { CreatedVnpayPayment } from '@ticketify/shared';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateVnpayPaymentDto } from './dto/create-vnpay-payment.dto';
import { PaymentRateLimiter } from './payment-rate-limiter';
import { PaymentService } from './payment.service';

const NOT_CONFIGURED =
  'PAYMENT_NOT_CONFIGURED: VNPAY_TMN_CODE, VNPAY_HASH_SECRET or VNPAY_RETURN_URL is not set';

@ApiTags('payments')
@Controller('payments/vnpay')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentService,
    private readonly rateLimiter: PaymentRateLimiter,
  ) {}

  @Post()
  @ApiBearerAuth()
  @ApiCreatedResponse({
    description:
      '{ paymentId, txnRef, paymentUrl, expiresAt }: a new Payment PENDING (one per call, each ' +
      'with its own txnRef) and the signed VNPay URL; vnp_ExpireDate = the booking expiresAt',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: bookingId is not a UUID' })
  @ApiNotFoundResponse({
    description: "BOOKING_NOT_FOUND: no such booking, or another user's (never 403)",
  })
  @ApiConflictResponse({
    description: 'BOOKING_NOT_PAYABLE: not PENDING; BOOKING_ALREADY_PAID: a SUCCESS payment',
  })
  @ApiUnprocessableEntityResponse({ description: 'BOOKING_EXPIRED: expiresAt has passed' })
  @ApiTooManyRequestsResponse({
    description:
      'TOO_MANY_ATTEMPTS (details.retryAfterSeconds): PAYMENT_RATE_LIMIT_MAX per user per ' +
      'PAYMENT_RATE_LIMIT_WINDOW_SECONDS',
  })
  @ApiServiceUnavailableResponse({ description: `${NOT_CONFIGURED}; nothing is written` })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateVnpayPaymentDto,
    @Req() req: Request,
  ): Promise<CreatedVnpayPayment> {
    // First of all: a refused request costs no configuration check and no database work.
    await this.rateLimiter.consumeCreate(user.id);
    return this.payments.createVnpay({
      userId: user.id,
      bookingId: dto.bookingId,
      clientIp: req.ip,
    });
  }
}
