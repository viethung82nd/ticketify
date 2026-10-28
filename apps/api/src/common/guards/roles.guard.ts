import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthErrorCode, type Role } from '@ticketify/shared';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { apiException } from '../errors/api-error';

/**
 * Global guard (APP_GUARD), runs after `JwtAuthGuard`.
 * No `@Roles` → any authenticated user. Wrong role → `403 FORBIDDEN` (the caller is known).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) {
      // Only possible when @Roles is combined with @Public.
      throw apiException(
        HttpStatus.UNAUTHORIZED,
        AuthErrorCode.UNAUTHORIZED,
        'Authentication required',
      );
    }
    if (!roles.includes(user.role)) {
      throw apiException(
        HttpStatus.FORBIDDEN,
        AuthErrorCode.FORBIDDEN,
        'You do not have permission to access this resource',
      );
    }
    return true;
  }
}
