import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type MiddlewareConsumer, Module, type NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { LoggerModule } from 'nestjs-pino';
import { validationExceptionFactory } from './common/errors/api-error';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AppConfigModule } from './config/app-config.module';
import { AppConfig } from './config/app-config.service';
import { TrustProxySetup } from './config/trust-proxy';
import { ClockModule } from './infra/clock/clock.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { CombosModule } from './modules/combos/combos.module';
import { HealthModule } from './modules/health/health.module';
import { MoviesModule } from './modules/movies/movies.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { ShowtimesModule } from './modules/showtimes/showtimes.module';
import { UsersModule } from './modules/users/users.module';

const requestIdFrom = (req: IncomingMessage): string => {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 128
    ? header
    : randomUUID();
};

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: requestIdFrom,
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          transport:
            config.get('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    ClockModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    HealthModule,
    AuthModule,
    UsersModule,
    MoviesModule,
    RoomsModule,
    PricingModule,
    ShowtimesModule,
    CombosModule,
  ],
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
    TrustProxySetup,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Needed for the refresh-token cookie. '*path' is the path-to-regexp v8 catch-all.
    consumer.apply(cookieParser()).forRoutes('*path');
  }
}
