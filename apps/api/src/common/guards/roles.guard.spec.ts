import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@ticketify/shared';
import type { AuthUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { httpErrorOf } from '../errors/testing/http-error';
import { RolesGuard } from './roles.guard';
import { httpContext } from './testing/execution-context';

class ProbeController {
  anyone(): void {}
  @Roles(Role.ADMIN)
  adminOnly(): void {}
  @Roles(Role.STAFF, Role.ADMIN)
  staffOrAdmin(): void {}
}

@Roles(Role.ADMIN)
class AdminController {
  handler(): void {}
  @Roles(Role.STAFF)
  staffOverride(): void {}
}

const asRole = (role: Role): AuthUser => ({ id: 'user-id', role });

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const run = (user: AuthUser | undefined, controller: new () => object, handler: string) =>
    guard.canActivate(httpContext({ user }, controller, handler));

  it('allows every authenticated user when the route has no @Roles', () => {
    for (const role of Object.values(Role)) {
      expect(run(asRole(role), ProbeController, 'anyone')).toBe(true);
    }
  });

  it.each([
    ['adminOnly', Role.ADMIN, true],
    ['adminOnly', Role.STAFF, false],
    ['adminOnly', Role.USER, false],
    ['staffOrAdmin', Role.STAFF, true],
    ['staffOrAdmin', Role.ADMIN, true],
    ['staffOrAdmin', Role.USER, false],
  ])('%s as %s → allowed=%s', (handler, role, allowed) => {
    if (allowed) {
      expect(run(asRole(role), ProbeController, handler)).toBe(true);
    } else {
      expect(httpErrorOf(() => run(asRole(role), ProbeController, handler))).toMatchObject({
        status: HttpStatus.FORBIDDEN,
        code: 'FORBIDDEN',
      });
    }
  });

  it('reads @Roles from the controller, and a handler-level @Roles overrides it', () => {
    expect(run(asRole(Role.ADMIN), AdminController, 'handler')).toBe(true);
    expect(httpErrorOf(() => run(asRole(Role.USER), AdminController, 'handler')).status).toBe(403);
    expect(run(asRole(Role.STAFF), AdminController, 'staffOverride')).toBe(true);
  });

  it('answers 401 (not 403) when a role is required but nobody is authenticated', () => {
    expect(httpErrorOf(() => run(undefined, ProbeController, 'adminOnly'))).toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      code: 'UNAUTHORIZED',
    });
  });
});
