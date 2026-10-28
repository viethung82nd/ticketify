import { HttpStatus, Injectable } from '@nestjs/common';
import { AuthErrorCode } from '@ticketify/shared';
import { apiException } from '../../../common/errors/api-error';
import { AppConfig } from '../../../config/app-config.service';
import type { User } from '../../../generated/prisma/client';
import { ClockService } from '../../../infra/clock/clock.service';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.util';

export interface IssuedRefreshToken {
  /** Raw token for the cookie. Never stored. */
  token: string;
  expiresAt: Date;
}

type RejectionCode =
  | typeof AuthErrorCode.REFRESH_TOKEN_INVALID
  | typeof AuthErrorCode.REFRESH_TOKEN_EXPIRED
  | typeof AuthErrorCode.REFRESH_TOKEN_REUSED;

const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  REFRESH_TOKEN_INVALID: 'Refresh token is invalid',
  REFRESH_TOKEN_EXPIRED: 'Refresh token expired',
  REFRESH_TOKEN_REUSED: 'Refresh token was already used; all sessions have been revoked',
};

/** Thrown inside the rotation transaction so Prisma rolls it back. */
class RefreshRejection extends Error {
  constructor(
    readonly code: RejectionCode,
    readonly userId?: string,
  ) {
    super(code);
  }
}

/**
 * Opaque refresh tokens with rotation and reuse detection (PLAN §3, `RefreshToken`).
 *
 * Each token is single-use: refreshing marks it `revokedAt` + `replacedById` (its successor).
 * Presenting a token that already has a successor means it leaked (or two clients raced),
 * so every live session of that user is revoked.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
  ) {}

  /** Row data for a brand-new token (also usable in a nested `create`). */
  newToken(): { token: string; data: { tokenHash: string; expiresAt: Date } } {
    const { token, tokenHash } = generateRefreshToken();
    const ttlMs = this.config.get('REFRESH_TOKEN_TTL_SECONDS') * 1_000;
    const expiresAt = new Date(this.clock.now().getTime() + ttlMs);
    return { token, data: { tokenHash, expiresAt } };
  }

  async issue(userId: string): Promise<IssuedRefreshToken> {
    const { token, data } = this.newToken();
    await this.prisma.refreshToken.create({ data: { ...data, userId } });
    return { token, expiresAt: data.expiresAt };
  }

  /**
   * Exchanges `rawToken` for a new token. Throws `401` with
   * `REFRESH_TOKEN_INVALID` (unknown or logged out), `REFRESH_TOKEN_EXPIRED` or
   * `REFRESH_TOKEN_REUSED` (after revoking every session of the user).
   */
  async rotate(rawToken: string): Promise<{ user: User; refresh: IssuedRefreshToken }> {
    const tokenHash = hashRefreshToken(rawToken);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = this.clock.now();
        const current = await tx.refreshToken.findUnique({
          where: { tokenHash },
          include: { user: true },
        });
        if (!current) throw new RefreshRejection(AuthErrorCode.REFRESH_TOKEN_INVALID);
        if (current.replacedById) {
          throw new RefreshRejection(AuthErrorCode.REFRESH_TOKEN_REUSED, current.userId);
        }
        // Revoked without a successor = logged out. Not a theft signal; leave other sessions.
        if (current.revokedAt) throw new RefreshRejection(AuthErrorCode.REFRESH_TOKEN_INVALID);
        if (current.expiresAt.getTime() <= now.getTime()) {
          throw new RefreshRejection(AuthErrorCode.REFRESH_TOKEN_EXPIRED);
        }

        const { token, data } = this.newToken();
        const next = await tx.refreshToken.create({ data: { ...data, userId: current.userId } });

        // Conditional claim: of N concurrent rotations of one token exactly one matches.
        // Losers block on the row lock, re-check the WHERE once the winner commits, and get 0.
        const claimed = await tx.refreshToken.updateMany({
          where: { id: current.id, revokedAt: null, replacedById: null },
          data: { revokedAt: now, replacedById: next.id },
        });
        if (claimed.count !== 1) {
          // Rolls back `next` together with the rest of this transaction.
          throw new RefreshRejection(AuthErrorCode.REFRESH_TOKEN_REUSED, current.userId);
        }

        return { user: current.user, refresh: { token, expiresAt: data.expiresAt } };
      });
    } catch (error) {
      if (!(error instanceof RefreshRejection)) throw error;
      if (error.code === AuthErrorCode.REFRESH_TOKEN_REUSED && error.userId) {
        // Must run outside the transaction above: the throw rolled back everything in it.
        await this.revokeAllForUser(error.userId);
      }
      throw apiException(HttpStatus.UNAUTHORIZED, error.code, REJECTION_MESSAGES[error.code]);
    }
  }

  /** Logout: revokes only this token. Unknown or already revoked tokens are ignored. */
  async revoke(rawToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    return count;
  }
}
