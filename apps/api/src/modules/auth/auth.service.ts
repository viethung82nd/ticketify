import { HttpStatus, Injectable } from '@nestjs/common';
import { type AuthSession, AuthErrorCode } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { Prisma, type User } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { toCurrentUser } from '../users/user-view';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { LoginRateLimiter } from './login-rate-limiter';
import { PasswordHasher } from './password/password-hasher';
import { AccessTokenIssuer } from './tokens/access-token.issuer';
import { RefreshTokenService } from './tokens/refresh-token.service';

/** What the controller needs: the JSON body and the raw refresh token for the cookie. */
export interface AuthResult {
  session: AuthSession;
  refreshToken: string;
}

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly refreshTokens: RefreshTokenService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  /** Creates the account and signs it in. Duplicate email (even under a race) → `409`. */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const passwordHash = await this.hasher.hash(dto.password);
    const { token, data } = this.refreshTokens.newToken();
    try {
      // The unique index on users.email is the only arbiter: no check-then-insert race.
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          fullName: dto.fullName,
          phone: dto.phone,
          refreshTokens: { create: data },
        },
      });
      return this.result(user, token);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw apiException(
          HttpStatus.CONFLICT,
          AuthErrorCode.EMAIL_TAKEN,
          'Email is already registered',
        );
      }
      throw error;
    }
  }

  /**
   * Wrong password and unknown email produce the same `401 INVALID_CREDENTIALS`, and an
   * unknown email still pays for one argon2 verification so timing does not tell them apart.
   */
  async login(dto: LoginDto, ip: string): Promise<AuthResult> {
    await this.rateLimiter.consume(dto.email, ip);

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      await this.hasher.burnTime(dto.password);
      throw invalidCredentials();
    }
    if (!(await this.hasher.matches(user.passwordHash, dto.password))) {
      throw invalidCredentials();
    }

    await this.rateLimiter.resetEmail(dto.email);
    const refresh = await this.refreshTokens.issue(user.id);
    return this.result(user, refresh.token);
  }

  async refresh(rawToken: string | undefined): Promise<AuthResult> {
    if (!rawToken) {
      throw apiException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCode.REFRESH_TOKEN_MISSING,
        'Refresh token cookie is missing',
      );
    }
    const { user, refresh } = await this.refreshTokens.rotate(rawToken);
    return this.result(user, refresh.token);
  }

  /** Revokes this session only. Idempotent: no cookie or an unknown token is fine. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await this.refreshTokens.revoke(rawToken);
  }

  private result(user: User, refreshToken: string): AuthResult {
    const access = this.accessTokens.issue(user);
    return {
      session: {
        accessToken: access.token,
        expiresIn: access.expiresIn,
        user: toCurrentUser(user),
      },
      refreshToken,
    };
  }
}

const invalidCredentials = () =>
  apiException(
    HttpStatus.UNAUTHORIZED,
    AuthErrorCode.INVALID_CREDENTIALS,
    'Email or password is incorrect',
  );
