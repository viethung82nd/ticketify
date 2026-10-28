import { SetMetadata } from '@nestjs/common';
import type { Role } from '@ticketify/shared';

export const ROLES_KEY = 'auth:roles';

/**
 * Restricts a route (or controller) to the given roles; checked by the global `RolesGuard`.
 * Routes without `@Roles` are open to every authenticated user.
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
