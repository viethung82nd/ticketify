import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { CommonErrorCode } from '@ticketify/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { isTransactionTimeout } from '../../infra/prisma/prisma-errors';
import { type ApiErrorBody, defaultErrorCode } from '../errors/api-error';

interface RequestLike {
  url?: string;
  id?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Turns every thrown error into the single `ApiErrorBody` shape.
 * Unknown errors become 500 without leaking internals to the client. A transaction that could not
 * start within `maxWait` or ran past `timeout` (Prisma `P2028`) becomes `503 DATABASE_BUSY`:
 * nothing was written and the client may retry. Both are still logged like any 5xx.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly clock: ClockService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestLike>();

    const body = this.toBody(exception, request);
    if (body.statusCode >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    httpAdapter.reply(ctx.getResponse(), body, body.statusCode);
  }

  toBody(exception: unknown, request: RequestLike): ApiErrorBody {
    const path = request.url ?? '';
    const requestId = typeof request.id === 'string' ? request.id : undefined;
    const timestamp = this.clock.now().toISOString();

    if (isTransactionTimeout(exception)) {
      const statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      return {
        statusCode,
        code: CommonErrorCode.DATABASE_BUSY,
        message: 'The database is busy, please try again',
        path,
        timestamp,
        requestId,
      };
    }

    if (!(exception instanceof HttpException)) {
      const statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      return {
        statusCode,
        code: defaultErrorCode(statusCode),
        message: 'Internal server error',
        path,
        timestamp,
        requestId,
      };
    }

    const statusCode = exception.getStatus();
    const response = exception.getResponse();
    let code = defaultErrorCode(statusCode);
    let message = exception.message;
    let details: unknown;

    if (typeof response === 'string') {
      message = response;
    } else if (isRecord(response)) {
      if (typeof response.code === 'string') code = response.code;
      if (typeof response.message === 'string') {
        message = response.message;
      } else if (Array.isArray(response.message)) {
        // Nest built-ins put a list of messages in `message`.
        details = response.message;
      }
      if (response.details !== undefined) details = response.details;
    }

    return { statusCode, code, message, details, path, timestamp, requestId };
  }
}
