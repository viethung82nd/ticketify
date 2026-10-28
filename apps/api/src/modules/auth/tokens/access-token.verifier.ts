import { HttpStatus, Injectable } from '@nestjs/common';
import { AuthErrorCode, Role } from '@ticketify/shared';
import { type JwtPayload, TokenExpiredError, verify } from 'jsonwebtoken';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';
import { apiException } from '../../../common/errors/api-error';
import { AppConfig } from '../../../config/app-config.service';
import { ClockService } from '../../../infra/clock/clock.service';
import { ACCESS_TOKEN_ALGORITHM, epochSeconds } from './access-token';

const ROLES = new Set<string>(Object.values(Role));

const isRole = (value: unknown): value is Role => typeof value === 'string' && ROLES.has(value);

const invalid = () =>
  apiException(HttpStatus.UNAUTHORIZED, AuthErrorCode.TOKEN_INVALID, 'Access token is invalid');

/**
 * Verifies access tokens against `JWT_ACCESS_SECRET`, accepting HS256 only.
 * Expiry is checked against `ClockService`, so tests can move time.
 */
@Injectable()
export class AccessTokenVerifier {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: ClockService,
  ) {}

  /** Returns the authenticated identity or throws `401 TOKEN_EXPIRED` / `401 TOKEN_INVALID`. */
  verify(token: string): AuthUser {
    let payload: string | JwtPayload;
    try {
      payload = verify(token, this.config.get('JWT_ACCESS_SECRET'), {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        clockTimestamp: epochSeconds(this.clock.now()),
      });
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw apiException(
          HttpStatus.UNAUTHORIZED,
          AuthErrorCode.TOKEN_EXPIRED,
          'Access token expired',
        );
      }
      throw invalid();
    }

    if (typeof payload === 'string' || typeof payload.sub !== 'string' || !isRole(payload.role)) {
      throw invalid();
    }
    // jsonwebtoken only checks `exp` when present; our tokens must always expire.
    if (typeof payload.exp !== 'number') throw invalid();
    return { id: payload.sub, role: payload.role };
  }
}
