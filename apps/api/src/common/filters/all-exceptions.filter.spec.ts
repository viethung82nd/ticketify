import {
  Body,
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  NotFoundException,
  Param,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Prisma } from '../../generated/prisma/client';
import { ClockService } from '../../infra/clock/clock.service';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { validationExceptionFactory } from '../errors/api-error';
import { AllExceptionsFilter } from './all-exceptions.filter';

class CreateThingDto {
  @IsString()
  name: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

@Controller('things')
class ThingsController {
  @Post()
  create(@Body() dto: CreateThingDto): CreateThingDto {
    return dto;
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('Thing not found');
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException({ code: 'SEAT_UNAVAILABLE', message: 'Seat taken', details: [1] });
  }

  @Get('boom')
  boom(): never {
    throw new Error('database password is hunter2');
  }
}

/** The messages Prisma 7 puts on its transaction API errors (all `P2028`). */
const TX_ERRORS = {
  'start-timeout': 'Transaction API error: Unable to start a transaction in the given time.',
  expired:
    'Transaction API error: A query cannot be executed on an expired transaction. The timeout ' +
    'for this transaction was 5000 ms, however 9042 ms passed since the start of the transaction.',
  closed:
    'Transaction API error: Transaction already closed: A query cannot be executed on a ' +
    'committed transaction.',
} as const;

const prismaError = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });

@Controller('tx')
class TransactionErrorsController {
  @Get(':kind')
  fail(@Param('kind') kind: keyof typeof TX_ERRORS | 'deadlock'): never {
    if (kind === 'deadlock') {
      throw prismaError('P2034', 'Transaction failed due to a write conflict or a deadlock.');
    }
    throw prismaError('P2028', TX_ERRORS[kind]);
  }
}

const NOW = '2026-11-01T03:00:00.000Z';

describe('global ValidationPipe + AllExceptionsFilter', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ThingsController, TransactionErrorsController],
      providers: [
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            exceptionFactory: validationExceptionFactory,
          }),
        },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: ClockService, useValue: new FakeClock(NOW) },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a valid body', async () => {
    const res = await request(app.getHttpServer())
      .post('/things')
      .send({ name: 'Popcorn', quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'Popcorn', quantity: 2 });
  });

  it('rejects unknown properties (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/things')
      .send({ name: 'Popcorn', quantity: 2, price: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      path: '/things',
      details: [{ field: 'price', messages: [expect.stringContaining('should not exist')] }],
    });
  });

  it('reports every invalid field', async () => {
    const res = await request(app.getHttpServer()).post('/things').send({ quantity: 0 });

    expect(res.status).toBe(400);
    const fields = (res.body as { details: { field: string }[] }).details.map((d) => d.field);
    expect(fields.sort()).toEqual(['name', 'quantity']);
  });

  it('maps HttpExceptions to the standard shape', async () => {
    const res = await request(app.getHttpServer()).get('/things/missing');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Thing not found',
      path: '/things/missing',
      timestamp: NOW,
    });
  });

  it('keeps custom error codes and details', async () => {
    const res = await request(app.getHttpServer()).get('/things/conflict');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'SEAT_UNAVAILABLE',
      message: 'Seat taken',
      details: [1],
    });
  });

  it('hides internals of unexpected errors', async () => {
    const res = await request(app.getHttpServer()).get('/things/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      path: '/things/boom',
      timestamp: NOW,
    });
  });

  it.each(['start-timeout', 'expired'])(
    'P2028 %s (nothing written, retryable) → 503 DATABASE_BUSY',
    async (kind) => {
      const res = await request(app.getHttpServer()).get(`/tx/${kind}`);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        statusCode: 503,
        code: 'DATABASE_BUSY',
        message: 'The database is busy, please try again',
        path: `/tx/${kind}`,
        timestamp: NOW,
      });
    },
  );

  it.each(['closed', 'deadlock'])(
    'P2028 on a closed transaction and P2034 stay 500',
    async (kind) => {
      const res = await request(app.getHttpServer()).get(`/tx/${kind}`);

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    },
  );

  it('maps unknown routes to 404 in the same shape', async () => {
    const res = await request(app.getHttpServer()).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', path: '/nope' });
  });
});
