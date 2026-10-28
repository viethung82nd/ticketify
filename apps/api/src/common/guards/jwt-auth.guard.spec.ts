import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@ticketify/shared';
import { testConfig } from '../../config/testing/test-config';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../modules/auth/tokens/access-token.issuer';
import { AccessTokenVerifier } from '../../modules/auth/tokens/access-token.verifier';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { httpErrorOf } from '../errors/testing/http-error';
import { JwtAuthGuard } from './jwt-auth.guard';
import { httpContext } from './testing/execution-context';

class ProtectedController {
  handler(): void {}
  @Public()
  openHandler(): void {}
}

@Public()
class PublicController {
  handler(): void {}
}

const USER = { id: '0195f0c6-7d3a-7000-8000-000000000001', role: Role.STAFF };

type TestRequest = AuthenticatedRequest & { headers: { authorization?: string } };

describe('JwtAuthGuard', () => {
  const config = testConfig();
  let clock: FakeClock;
  let issuer: AccessTokenIssuer;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    clock = new FakeClock('2026-11-02T03:00:00.000Z');
    issuer = new AccessTokenIssuer(config, clock);
    guard = new JwtAuthGuard(new Reflector(), new AccessTokenVerifier(config, clock));
  });

  const run = (
    request: TestRequest,
    controller: new () => object = ProtectedController,
    handler = 'handler',
  ) => guard.canActivate(httpContext(request, controller, handler));

  it.each([
    ['a @Public() handler', ProtectedController, 'openHandler'],
    ['a @Public() controller', PublicController, 'handler'],
  ])('lets %s through without a token', (_label, controller, handler) => {
    const request: TestRequest = { headers: {} };

    expect(run(request, controller, handler)).toBe(true);
    expect(request.user).toBeUndefined();
  });

  it.each([
    ['no header', undefined],
    ['an empty bearer', 'Bearer '],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
  ])('rejects %s with 401 UNAUTHORIZED', (_label, authorization) => {
    expect(httpErrorOf(() => run({ headers: { authorization } }))).toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects an expired token with 401 TOKEN_EXPIRED', () => {
    const { token } = issuer.issue(USER);
    clock.advance({ minutes: 15 });

    expect(httpErrorOf(() => run({ headers: { authorization: `Bearer ${token}` } }))).toMatchObject(
      { status: HttpStatus.UNAUTHORIZED, code: 'TOKEN_EXPIRED' },
    );
  });

  it('rejects a malformed token with 401 TOKEN_INVALID', () => {
    expect(
      httpErrorOf(() => run({ headers: { authorization: 'Bearer abc.def.ghi' } })),
    ).toMatchObject({ status: HttpStatus.UNAUTHORIZED, code: 'TOKEN_INVALID' });
  });

  it('attaches the identity to request.user for a valid token', () => {
    const { token } = issuer.issue(USER);
    const request: TestRequest = { headers: { authorization: `bearer ${token}` } };

    expect(run(request)).toBe(true);
    expect(request.user).toEqual(USER);
  });
});
