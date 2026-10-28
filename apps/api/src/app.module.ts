import { type MiddlewareConsumer, Module, type NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { validationExceptionFactory } from './common/errors/api-error';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AppConfigModule } from './config/app-config.module';
import { pinoLoggerModule } from './config/logger.module';
import { TrustProxySetup } from './config/trust-proxy';
import { ClockModule } from './infra/clock/clock.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { CombosModule } from './modules/combos/combos.module';
import { HealthModule } from './modules/health/health.module';
import { MoviesModule } from './modules/movies/movies.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { ShowtimesModule } from './modules/showtimes/showtimes.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    AppConfigModule,
    pinoLoggerModule(),
    ClockModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    HealthModule,
    AuthModule,
    UsersModule,
    MoviesModule,
    RoomsModule,
    PricingModule,
    ShowtimesModule,
    CombosModule,
    BookingsModule,
    RealtimeModule,
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
