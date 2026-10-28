import { HttpStatus } from '@nestjs/common';
import { Role } from '@ticketify/shared';
import { sign } from 'jsonwebtoken';
import { httpErrorOf } from '../../../common/errors/testing/http-error';
import { testConfig } from '../../../config/testing/test-config';
import { FakeClock } from '../../../infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from './access-token.issuer';
import { AccessTokenVerifier } from './access-token.verifier';

const START = '2026-11-02T03:00:00.000Z';
const USER = { id: '0195f0c6-7d3a-7000-8000-000000000001', role: Role.USER };

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('AccessTokenVerifier', () => {
  const config = testConfig();
  let clock: FakeClock;
  let issuer: AccessTokenIssuer;
  let verifier: AccessTokenVerifier;

  beforeEach(() => {
    clock = new FakeClock(START);
    issuer = new AccessTokenIssuer(config, clock);
    verifier = new AccessTokenVerifier(config, clock);
  });

  const expectInvalid = (token: string) =>
    expect(httpErrorOf(() => verifier.verify(token))).toEqual({
      status: HttpStatus.UNAUTHORIZED,
      code: 'TOKEN_INVALID',
      details: undefined,
    });

  it('accepts a token it issued and returns the identity', () => {
    const { token, expiresIn } = issuer.issue(USER);

    expect(expiresIn).toBe(900);
    expect(verifier.verify(token)).toEqual(USER);
  });

  it('puts sub, role, iat and exp (from ClockService) in the HS256 token', () => {
    const { token } = issuer.issue(USER);
    const [header, payload] = token.split('.');

    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({
      alg: 'HS256',
    });
    const iat = Date.parse(START) / 1000;
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      sub: USER.id,
      role: 'USER',
      iat,
      exp: iat + 900,
    });
  });

  it('rejects an expired token with TOKEN_EXPIRED (expiry follows ClockService)', () => {
    const { token } = issuer.issue(USER);

    clock.advance({ seconds: 899 });
    expect(verifier.verify(token)).toEqual(USER);

    clock.advance({ seconds: 1 });
    expect(httpErrorOf(() => verifier.verify(token))).toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      code: 'TOKEN_EXPIRED',
    });
  });

  it('rejects a token signed with another secret', () => {
    const iat = Date.parse(START) / 1000;
    const forged = sign(
      { sub: USER.id, role: 'ADMIN', iat, exp: iat + 900 },
      'attacker-secret-attacker-secret-0123456789',
      { algorithm: 'HS256' },
    );

    expectInvalid(forged);
  });

  it('rejects an unsigned token (alg: none)', () => {
    const iat = Date.parse(START) / 1000;
    const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: USER.id,
      role: 'ADMIN',
      iat,
      exp: iat + 900,
    })}.`;

    expectInvalid(unsigned);
  });

  it('rejects a token whose payload was edited (role escalated)', () => {
    const [header, payload, signature] = issuer.issue(USER).token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as object;
    const tampered = `${header}.${base64url({ ...claims, role: 'ADMIN' })}.${signature}`;

    expectInvalid(tampered);
  });

  it('rejects a correctly signed token with an unknown role or without exp', () => {
    const secret = config.get('JWT_ACCESS_SECRET');
    const iat = Date.parse(START) / 1000;

    expectInvalid(sign({ sub: USER.id, role: 'ROOT', iat, exp: iat + 900 }, secret));
    expectInvalid(sign({ sub: USER.id, role: 'USER', iat }, secret));
  });

  it('rejects garbage', () => {
    expectInvalid('not.a.jwt');
    expectInvalid('');
  });
});
