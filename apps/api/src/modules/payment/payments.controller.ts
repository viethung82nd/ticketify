import { Body, Controller, Get, HttpStatus, Logger, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { CreatedVnpayPayment, VnpayReturnResult } from '@ticketify/shared';
import type { Request, Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CreateVnpayPaymentDto } from './dto/create-vnpay-payment.dto';
import { PaymentRateLimiter } from './payment-rate-limiter';
import { PaymentService } from './payment.service';
import { VnpayIpnResponse } from './vnpay/vnpay-ipn';

const NOT_CONFIGURED =
  'PAYMENT_NOT_CONFIGURED: VNPAY_TMN_CODE, VNPAY_HASH_SECRET or VNPAY_RETURN_URL is not set';

@ApiTags('payments')
@Controller('payments/vnpay')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

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

  @Get('return')
  @Public()
  @ApiOkResponse({
    description:
      'Display only, changes nothing. Bad signature or unknown vnp_TxnRef: { verified: false }. ' +
      'Otherwise { verified: true, bookingId, paymentStatus (as stored: PENDING until the IPN), ' +
      'vnpResponseCode, amountMismatch }',
  })
  @ApiTooManyRequestsResponse({
    description:
      'TOO_MANY_ATTEMPTS (details.retryAfterSeconds): PAYMENT_RETURN_RATE_LIMIT_MAX per client IP',
  })
  @ApiServiceUnavailableResponse({ description: NOT_CONFIGURED })
  async vnpayReturn(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
  ): Promise<VnpayReturnResult> {
    await this.rateLimiter.consumeReturn(req.ip ?? 'unknown');
    return this.payments.vnpayReturn(query);
  }

  /**
   * VNPay's server-to-server payment result. Answered as VNPay expects, not with the API error
   * shape: HTTP 200 and `{ RspCode, Message }` for every outcome it can act on, HTTP 500 and
   * `{ RspCode: '99' }` for an unexpected error, which wrote nothing (VNPay calls again). No rate
   * limit: VNPay retries on its own schedule, and an unsigned request costs one HMAC.
   */
  @Get('ipn')
  @Public()
  @ApiOkResponse({
    description:
      '{ RspCode, Message }: 97 invalid signature, 01 order not found, 04 invalid amount, ' +
      '02 already confirmed, 00 confirm success (paid: CONFIRMED or NEEDS_REVIEW; not paid: ' +
      'payment FAILED, booking unchanged). VNPay calls again on 01, 04, 97 and 99',
  })
  @ApiInternalServerErrorResponse({
    description: '{ RspCode: 99, Message: "Unknown error" }: unexpected error, nothing written',
  })
  async vnpayIpn(@Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    let status: number = HttpStatus.OK;
    let body: VnpayIpnResponse;
    try {
      body = await this.payments.vnpayIpn(query);
    } catch (error) {
      // Whatever it was, the transaction did not commit: nothing is half written.
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = VnpayIpnResponse.UNKNOWN_ERROR;
      const txnRef = typeof query.vnp_TxnRef === 'string' ? query.vnp_TxnRef : '-';
      this.logger.error(
        `IPN 500 for vnp_TxnRef ${txnRef}, nothing written; VNPay will call again`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    res.status(status).json(body);
  }
}
