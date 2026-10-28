import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimiter } from './login-rate-limiter';
import { PasswordHasher } from './password/password-hasher';
import { RefreshCookie } from './refresh-cookie';
import { AccessTokenIssuer } from './tokens/access-token.issuer';
import { AccessTokenVerifier } from './tokens/access-token.verifier';
import { RefreshTokenService } from './tokens/refresh-token.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordHasher,
    AccessTokenIssuer,
    AccessTokenVerifier,
    RefreshTokenService,
    RefreshCookie,
    RateLimitService,
    LoginRateLimiter,
    // Global guards run in registration order: authenticate first, then check roles.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AccessTokenVerifier],
})
export class AuthModule {}
