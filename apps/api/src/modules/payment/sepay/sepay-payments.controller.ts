import {
  Body,
  Controller,
  HttpStatus,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
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
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { CreatedSepayPayment } from '@ticketify/shared';
import type { Request, Response } from 'express';
import { type AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { CreateSepayPaymentDto } from '../dto/create-sepay-payment.dto';
import { PaymentRateLimiter } from '../payment-rate-limiter';
import { SepayPaymentService } from './sepay-payment.service';

const NOT_CONFIGURED =
  'PAYMENT_NOT_CONFIGURED: SEPAY_WEBHOOK_SECRET, SEPAY_BANK_ACCOUNT_NUMBER or SEPAY_BANK_CODE ' +
  'is not set';

@ApiTags('payments')
@Controller('payments/sepay')
export class SepayPaymentsController {
  private readonly logger = new Logger(SepayPaymentsController.name);

  constructor(
    private readonly sepay: SepayPaymentService,
    private readonly rateLimiter: PaymentRateLimiter,
  ) {}

  @Post()
  @ApiBearerAuth()
  @ApiCreatedResponse({
    description:
      '{ paymentId, provider: "SEPAY", amount, transferContent, qrCodeUrl, bankCode, ' +
      'accountNumber, accountHolder, expiresAt, reused }: what to transfer, and where. One open ' +
      'SePay attempt per booking: calling again while it is PENDING hands the same one back ' +
      '(reused: true). Never means "paid": only SePay’s webhook confirms the booking',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: bookingId is not a UUID' })
  @ApiNotFoundResponse({
    description: "BOOKING_NOT_FOUND: no such booking, or another user's (never 403)",
  })
  @ApiConflictResponse({
    description:
      'BOOKING_NOT_PAYABLE: not PENDING; BOOKING_ALREADY_PAID: a SUCCESS payment (any gateway)',
  })
  @ApiUnprocessableEntityResponse({ description: 'BOOKING_EXPIRED: expiresAt has passed' })
  @ApiTooManyRequestsResponse({
    description:
      'TOO_MANY_ATTEMPTS (details.retryAfterSeconds): the same per-user budget as ' +
      'POST /payments/vnpay and /payments/momo',
  })
  @ApiServiceUnavailableResponse({ description: NOT_CONFIGURED })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSepayPaymentDto,
  ): Promise<CreatedSepayPayment> {
    // First of all: a refused request costs no configuration check and no database work.
    await this.rateLimiter.consumeCreate(user.id);
    return this.sepay.create({ userId: user.id, bookingId: dto.bookingId });
  }

  /**
   * SePay's server-to-server bank-transaction notification (JSON, HMAC-SHA256 signed). Answered as
   * SePay expects, not with the API error shape: `200 {"success": true}` once handled,
   * `{"success": false, "message"}` with 401 / 400 / 503 otherwise, 500 for an unexpected error,
   * which wrote nothing. No JWT and no rate limit: SePay calls on its own schedule, and an
   * unsigned request costs one HMAC.
   */
  @Post('webhook')
  @Public()
  @ApiOkResponse({
    description:
      '{"success": true}: handled — settled, recorded without settling (money out, another ' +
      'account, no or unknown payment code, wrong amount, second transfer) or a repeat',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid X-SePay-Signature, or X-SePay-Timestamp outside ±300 s',
  })
  @ApiBadRequestResponse({ description: 'Not JSON, or a field missing or malformed' })
  @ApiServiceUnavailableResponse({ description: 'SePay is not configured on this server' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected error, nothing written' })
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const result = await this.sepay.webhook({
        body,
        rawBody: req.rawBody,
        headers: req.headers,
        contentType: req.headers['content-type'],
      });
      if (result.status === 200) {
        res.status(HttpStatus.OK).json({ success: true });
        return;
      }
      res.status(result.status).json({ success: false, message: result.reason });
    } catch (error) {
      // Whatever it was, the transaction did not commit: nothing is half written.
      const id =
        typeof body === 'object' && body !== null && 'id' in body
          ? String(body.id).slice(0, 32)
          : '-';
      this.logger.error(
        `SePay webhook 500 for transaction ${id}, nothing written`,
        error instanceof Error ? error.stack : String(error),
      );
      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ success: false, message: 'Internal error' });
    }
  }
}
