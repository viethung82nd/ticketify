import { Injectable } from '@nestjs/common';
import type { Role } from '@ticketify/shared';
import { sign } from 'jsonwebtoken';
import { AppConfig } from '../../../config/app-config.service';
import { ClockService } from '../../../infra/clock/clock.service';
import { ACCESS_TOKEN_ALGORITHM, epochSeconds } from './access-token';

export interface IssuedAccessToken {
  token: string;
  /** Lifetime in seconds. */
  expiresIn: number;
}

/** Signs short-lived access tokens (`sub`, `role`). Times come from `ClockService`. */
@Injectable()
export class AccessTokenIssuer {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: ClockService,
  ) {}

  issue(user: { id: string; role: Role }): IssuedAccessToken {
    const expiresIn = this.config.get('ACCESS_TOKEN_TTL_SECONDS');
    const iat = epochSeconds(this.clock.now());
    const token = sign(
      { sub: user.id, role: user.role, iat, exp: iat + expiresIn },
      this.config.get('JWT_ACCESS_SECRET'),
      { algorithm: ACCESS_TOKEN_ALGORITHM },
    );
    return { token, expiresIn };
  }
}
