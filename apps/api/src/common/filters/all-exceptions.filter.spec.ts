import {
  Body,
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  NotFoundException,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import request from 'supertest';
import type { App } from 'supertest/types';
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

describe('global ValidationPipe + AllExceptionsFilter', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ThingsController],
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
    });
  });

  it('maps unknown routes to 404 in the same shape', async () => {
    const res = await request(app.getHttpServer()).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', path: '/nope' });
  });
});
