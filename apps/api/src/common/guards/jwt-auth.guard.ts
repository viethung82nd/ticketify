import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthErrorCode } from '@ticketify/shared';
import { AccessTokenVerifier } from '../../modules/auth/tokens/access-token.verifier';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { apiException } from '../errors/api-error';

interface RequestWithHeaders extends AuthenticatedRequest {
  headers: { authorization?: string };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Global guard (APP_GUARD): every route needs a valid access token unless marked `@Public()`.
 * Errors: `UNAUTHORIZED` (no token), `TOKEN_EXPIRED`, `TOKEN_INVALID`. WebSocket messages are
 * let through: their socket was authenticated at the handshake.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // Socket.IO messages: the gateway authenticated the socket once, at the handshake, with the
    // same verifier (RealtimeGateway.authenticate). A message carries no Authorization header.
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      throw apiException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCode.UNAUTHORIZED,
        'Authentication required',
      );
    }

    // Throws TOKEN_EXPIRED / TOKEN_INVALID.
    request.user = this.verifier.verify(token);
    return true;
  }
}
