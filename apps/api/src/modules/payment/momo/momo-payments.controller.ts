import { Body, Controller, Get, HttpStatus, Logger, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { CreatedMomoPayment, MomoReturnResult } from '@ticketify/shared';
import type { Request, Response } from 'express';
import { type AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { CreateMomoPaymentDto } from '../dto/create-momo-payment.dto';
import { PaymentRateLimiter } from '../payment-rate-limiter';
import { MomoPaymentService } from './momo-payment.service';

const NOT_CONFIGURED =
  'PAYMENT_NOT_CONFIGURED: MOMO_PARTNER_CODE, MOMO_ACCESS_KEY, MOMO_SECRET_KEY, ' +
  'MOMO_REDIRECT_URL or MOMO_IPN_URL is not set';

@ApiTags('payments')
@Controller('payments/momo')
export class MomoPaymentsController {
  private readonly logger = new Logger(MomoPaymentsController.name);

  constructor(
    private readonly momo: MomoPaymentService,
    private readonly rateLimiter: PaymentRateLimiter,
  ) {}

  @Post()
  @ApiBearerAuth()
  @ApiCreatedResponse({
    description:
      '{ paymentId, orderId, payUrl, expiresAt, reused }: the booking’s MoMo payment page. ' +
      'One open MoMo attempt per booking: calling again while it is PENDING hands the same ' +
      'attempt back (reused: true) instead of opening a second MoMo order',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: bookingId is not a UUID' })
  @ApiNotFoundResponse({
    description: "BOOKING_NOT_FOUND: no such booking, or another user's (never 403)",
  })
  @ApiConflictResponse({
    description:
      'BOOKING_NOT_PAYABLE: not PENDING (or the attempt closed meanwhile); ' +
      'BOOKING_ALREADY_PAID: a SUCCESS payment',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'BOOKING_EXPIRED: expiresAt has passed; PAYMENT_AMOUNT_NOT_SUPPORTED: outside ' +
      '1 000 – 50 000 000 VND',
  })
  @ApiTooManyRequestsResponse({
    description:
      'TOO_MANY_ATTEMPTS (details.retryAfterSeconds): the same per-user budget as ' +
      'POST /payments/vnpay (PAYMENT_RATE_LIMIT_MAX per PAYMENT_RATE_LIMIT_WINDOW_SECONDS)',
  })
  @ApiBadGatewayResponse({
    description:
      'PAYMENT_PROVIDER_ERROR (details.resultCode): MoMo refused the request; the attempt is ' +
      'FAILED and the next call opens a new one',
  })
  @ApiServiceUnavailableResponse({
    description:
      `${NOT_CONFIGURED}; or PAYMENT_PROVIDER_UNAVAILABLE: MoMo did not answer in time ` +
      '(MOMO_REQUEST_TIMEOUT_MS) or is still processing; the attempt stays PENDING and the next ' +
      'call re-sends the same request',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMomoPaymentDto,
  ): Promise<CreatedMomoPayment> {
    // First of all: a refused request costs no configuration check and no database work.
    await this.rateLimiter.consumeCreate(user.id);
    return this.momo.create({ userId: user.id, bookingId: dto.bookingId });
  }

  @Get('return')
  @Public()
  @ApiOkResponse({
    description:
      'Display only, changes nothing. Bad signature, another partnerCode or unknown orderId: ' +
      '{ verified: false }. Otherwise { verified: true, bookingId, paymentStatus (as stored: ' +
      'PENDING until the IPN), resultCode, amountMismatch }',
  })
  @ApiTooManyRequestsResponse({
    description:
      'TOO_MANY_ATTEMPTS (details.retryAfterSeconds): PAYMENT_RETURN_RATE_LIMIT_MAX per client IP',
  })
  @ApiServiceUnavailableResponse({ description: 'PAYMENT_NOT_CONFIGURED: MoMo keys are not set' })
  async momoReturn(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
  ): Promise<MomoReturnResult> {
    await this.rateLimiter.consumeReturn(req.ip ?? 'unknown');
    return this.momo.verifyReturn(query);
  }

  /**
   * MoMo's server-to-server payment result (JSON). Answered as MoMo expects, not with the API
   * error shape: 204 without a body once handled, 400 for a body that does not verify, 500 for
   * an unexpected error, which wrote nothing. No JWT and no rate limit: MoMo calls on its own
   * schedule, and an unsigned request costs one HMAC.
   */
  @Post('ipn')
  @Public()
  @ApiNoContentResponse({
    description:
      'Handled: recorded (paid, failed, paid twice, review), a repeat, not final yet, or about ' +
      'an order this server does not have',
  })
  @ApiBadRequestResponse({
    description: 'Not verifiable: malformed body, invalid signature or another partnerCode',
  })
  @ApiInternalServerErrorResponse({ description: 'Unexpected error, nothing written' })
  async momoIpn(@Body() body: unknown, @Res() res: Response): Promise<void> {
    try {
      const result = await this.momo.ipn(body);
      if (result.acknowledged) {
        res.status(HttpStatus.NO_CONTENT).end();
        return;
      }
      res.status(HttpStatus.BAD_REQUEST).json({ message: result.reason });
    } catch (error) {
      // Whatever it was, the transaction did not commit: nothing is half written.
      const orderId =
        typeof body === 'object' && body !== null && 'orderId' in body
          ? String(body.orderId).slice(0, 64)
          : '-';
      this.logger.error(
        `MoMo IPN 500 for orderId ${orderId}, nothing written`,
        error instanceof Error ? error.stack : String(error),
      );
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Unknown error' });
    }
  }
}
