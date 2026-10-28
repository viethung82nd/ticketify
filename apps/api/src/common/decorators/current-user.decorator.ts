import { createParamDecorator, type ExecutionContext, HttpStatus } from '@nestjs/common';
import type { Role } from '@ticketify/shared';
import { apiException } from '../errors/api-error';

/** Identity taken from a verified access token and attached to `request.user`. */
export interface AuthUser {
  id: string;
  role: Role;
}

export interface AuthenticatedRequest {
  user?: AuthUser;
}

/** Injects `request.user`. Only meaningful on routes protected by `JwtAuthGuard`. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
  if (!user) {
    // Reached only if @CurrentUser is used on a @Public route without a token.
    throw apiException(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Authentication required');
  }
  return user;
});
