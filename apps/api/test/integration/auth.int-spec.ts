import { createHash } from 'node:crypto';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { type AuthSession, type CurrentUser as CurrentUserView, Role } from '@ticketify/shared';
import { Redis } from 'ioredis';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { type AuthUser, CurrentUser } from '../../src/common/decorators/current-user.decorator';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, cookieValue, errorOf, setCookieLine } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

const START = '2026-11-02T03:00:00.000Z';
const PASSWORD = 'correct horse battery';
const COOKIE = 'refresh_token';
const LOGIN_MAX = 5;
const IP_MAX = LOGIN_MAX * 4;
const DEAD_REDIS = 'redis://127.0.0.1:1';

/** Routes that exist only in this test, to observe the global guards. */
@Controller('test-probe')
class ProbeController {
  @Get('anyone')
  anyone(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Roles(Role.ADMIN)
  @Get('admin')
  admin(): { ok: true } {
    return { ok: true };
  }

  @Roles(Role.STAFF, Role.ADMIN)
  @Get('staff')
  staff(): { ok: true } {
    return { ok: true };
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

let emailSeq = 0;
const uniqueEmail = (): string => `user${++emailSeq}-${process.pid}@test.local`;

describe('Auth (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let clock: FakeClock;
  let app: INestApplication<App>;
  let AppModule: new () => unknown;
  let REDIS: symbol;

  async function startApp(
    override?: (builder: TestingModuleBuilder) => void,
  ): Promise<INestApplication<App>> {
    const builder = Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(ClockService)
      .useValue(clock);
    override?.(builder);
    const nest = (await builder.compile()).createNestApplication<INestApplication<App>>({
      logger: false,
    });
    // Listen on a real port so concurrent supertest requests share one server.
    await nest.listen(0, '127.0.0.1');
    return nest;
  }

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    // ConfigModule reads process.env when the module graph is first imported.
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        { LOGIN_RATE_LIMIT_MAX: String(LOGIN_MAX), LOGIN_RATE_LIMIT_WINDOW_SECONDS: '900' },
      ),
    );
    ({ AppModule } = await import('../../src/app.module.js'));
    ({ REDIS } = await import('../../src/infra/redis/redis.module.js'));
    clock = new FakeClock(START);
    app = await startApp();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(async () => {
    clock.set(START);
    // Login counters are per IP and every request comes from 127.0.0.1.
    await redis.client.flushdb();
  });

  // ─── HTTP helpers ───

  const http = () => request(app.getHttpServer());

  const register = (email = uniqueEmail(), password = PASSWORD) =>
    http().post('/auth/register').send({ email, password, fullName: 'Nguyễn Văn An' });

  const login = (email: string, password = PASSWORD) =>
    http().post('/auth/login').send({ email, password });

  const refresh = (token?: string) => {
    const req = http().post('/auth/refresh');
    return token === undefined ? req : req.set('Cookie', `${COOKIE}=${token}`);
  };

  const logout = (token?: string) => {
    const req = http().post('/auth/logout');
    return token === undefined ? req : req.set('Cookie', `${COOKIE}=${token}`);
  };

  const getAs = (path: string, accessToken?: string) => {
    const req = http().get(path);
    return accessToken ? req.set('Authorization', `Bearer ${accessToken}`) : req;
  };

  const sessionOf = (res: Response) => bodyOf<AuthSession>(res);

  const refreshTokenOf = (res: Response): string => {
    const value = cookieValue(res, COOKIE);
    if (!value) throw new Error(`Response ${res.status} did not set ${COOKIE}`);
    return value;
  };

  /** Registers a user and returns its email, session and refresh token. */
  async function signUp(email = uniqueEmail()) {
    const res = await register(email);
    expect(res.status).toBe(201);
    return { email, session: sessionOf(res), refreshToken: refreshTokenOf(res) };
  }

  async function signUpAs(role: Role) {
    const { email } = await signUp();
    await db.prisma.user.update({ where: { email }, data: { role } });
    const res = await login(email);
    expect(res.status).toBe(200);
    return sessionOf(res).accessToken;
  }

  const liveTokenCount = (userId: string) =>
    db.prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  const expectCookieCleared = (res: Response) => {
    expect(setCookieLine(res, COOKIE)).toMatch(/^refresh_token=;.*Expires=Thu, 01 Jan 1970/);
  };

  // ─── 1.1 Register & login ───

  describe('register and login', () => {
    it('registers, normalizes the email, sets the refresh cookie and stores only hashes', async () => {
      const res = await register('  An.Nguyen+1@Example.COM ');

      expect(res.status).toBe(201);
      const session = sessionOf(res);
      expect(session).toEqual({
        accessToken: expect.any(String) as string,
        expiresIn: 900,
        user: {
          id: expect.any(String) as string,
          email: 'an.nguyen+1@example.com',
          fullName: 'Nguyễn Văn An',
          phone: null,
          role: 'USER',
          createdAt: expect.any(String) as string,
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);

      const line = setCookieLine(res, COOKIE) ?? '';
      expect(line).toMatch(/HttpOnly/);
      expect(line).toMatch(/SameSite=Strict/);
      expect(line).toMatch(/Path=\/auth(;|$)/);
      expect(line).toMatch(/Max-Age=604800/);
      expect(line).not.toMatch(/Secure/); // only in production

      const raw = refreshTokenOf(res);
      const user = await db.prisma.user.findUniqueOrThrow({
        where: { email: 'an.nguyen+1@example.com' },
        include: { refreshTokens: true },
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.refreshTokens).toHaveLength(1);
      expect(user.refreshTokens[0]?.tokenHash).toBe(sha256(raw));
      expect(user.refreshTokens[0]?.expiresAt.toISOString()).toBe('2026-11-09T03:00:00.000Z');
    });

    it('logs in (email in any case) and GET /me returns the profile', async () => {
      const { email } = await signUp();

      const res = await login(` ${email.toUpperCase()} `);
      expect(res.status).toBe(200);
      expect(cookieValue(res, COOKIE)).toBeTruthy();

      const me = await getAs('/me', sessionOf(res).accessToken);
      expect(me.status).toBe(200);
      expect(bodyOf<CurrentUserView>(me)).toMatchObject({ email, role: 'USER' });
    });

    it('rejects invalid input with 400 VALIDATION_FAILED', async () => {
      const res = await http()
        .post('/auth/register')
        .send({ email: 'not-an-email', password: 'short', fullName: '  ' });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('15 concurrent registrations of one email → exactly one 201, the rest 409 EMAIL_TAKEN', async () => {
      const email = uniqueEmail();
      const variants = Array.from({ length: 15 }, (_, i) =>
        i % 2 === 0 ? email : ` ${email.toUpperCase()}`,
      );

      const responses = await Promise.all(variants.map((variant) => register(variant)));

      const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
      expect(statuses).toEqual([201, ...Array<number>(14).fill(409)]);
      for (const res of responses.filter((r) => r.status === 409)) {
        expect(errorOf(res).code).toBe('EMAIL_TAKEN');
      }
      await expect(db.prisma.user.count({ where: { email } })).resolves.toBe(1);
    });

    it('answers a wrong password and an unknown email identically', async () => {
      const { email } = await signUp();

      const wrongPassword = await login(email, 'wrong password!');
      const unknownEmail = await login(uniqueEmail(), 'wrong password!');

      for (const res of [wrongPassword, unknownEmail]) {
        expect(res.status).toBe(401);
        expect(cookieValue(res, COOKIE)).toBeUndefined();
      }
      const comparable = (res: Response) => {
        const { code, message, statusCode } = errorOf(res);
        return { code, message, statusCode };
      };
      expect(comparable(wrongPassword)).toEqual({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect',
      });
      expect(comparable(unknownEmail)).toEqual(comparable(wrongPassword));
    });
  });

  // ─── Access tokens & guards ───

  describe('access token guard', () => {
    it('GET /health stays public', async () => {
      expect((await getAs('/health')).status).toBe(200);
    });

    it('401 UNAUTHORIZED without a token', async () => {
      const res = await getAs('/me');

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('UNAUTHORIZED');
    });

    it('401 TOKEN_EXPIRED once the access token is 15 minutes old', async () => {
      const { session } = await signUp();

      clock.advance({ minutes: 14, seconds: 59 });
      expect((await getAs('/me', session.accessToken)).status).toBe(200);

      clock.advance({ seconds: 1 });
      const res = await getAs('/me', session.accessToken);
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('TOKEN_EXPIRED');
    });

    it('401 TOKEN_INVALID for a token whose role claim was edited', async () => {
      const { session } = await signUp();
      const [header, payload, signature] = session.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as object;
      const forgedPayload = Buffer.from(JSON.stringify({ ...claims, role: 'ADMIN' })).toString(
        'base64url',
      );

      const res = await getAs('/test-probe/admin', `${header}.${forgedPayload}.${signature}`);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('TOKEN_INVALID');
    });

    it('GET /me → 404 USER_NOT_FOUND when the account was deleted', async () => {
      const { session } = await signUp();
      await db.prisma.user.delete({ where: { id: session.user.id } });

      const res = await getAs('/me', session.accessToken);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('USER_NOT_FOUND');
    });
  });

  describe('roles', () => {
    it('a route without @Roles is open to every signed-in user', async () => {
      const { session } = await signUp();

      const res = await getAs('/test-probe/anyone', session.accessToken);

      expect(res.status).toBe(200);
      expect(bodyOf<AuthUser>(res)).toEqual({ id: session.user.id, role: 'USER' });
    });

    it('401 when anonymous, 403 FORBIDDEN with the wrong role, 200 with the right one', async () => {
      const [user, staff, admin] = await Promise.all([
        signUpAs(Role.USER),
        signUpAs(Role.STAFF),
        signUpAs(Role.ADMIN),
      ]);

      const anonymous = await getAs('/test-probe/admin');
      expect(anonymous.status).toBe(401);
      expect(errorOf(anonymous).code).toBe('UNAUTHORIZED');

      const forbidden = await getAs('/test-probe/admin', user);
      expect(forbidden.status).toBe(403);
      expect(errorOf(forbidden).code).toBe('FORBIDDEN');

      expect((await getAs('/test-probe/admin', staff)).status).toBe(403);
      expect((await getAs('/test-probe/admin', admin)).status).toBe(200);
      expect((await getAs('/test-probe/staff', user)).status).toBe(403);
      expect((await getAs('/test-probe/staff', staff)).status).toBe(200);
      expect((await getAs('/test-probe/staff', admin)).status).toBe(200);
    });
  });

  // ─── 1.2 Refresh rotation, reuse, logout ───

  describe('refresh', () => {
    it('rotates: new access token + new cookie; the old row points to its successor', async () => {
      const { session, refreshToken } = await signUp();
      clock.advance({ minutes: 20 });

      const res = await refresh(refreshToken);

      expect(res.status).toBe(200);
      const next = refreshTokenOf(res);
      expect(next).not.toBe(refreshToken);
      expect(sessionOf(res).user.id).toBe(session.user.id);
      expect((await getAs('/me', sessionOf(res).accessToken)).status).toBe(200);

      const old = await db.prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: sha256(refreshToken) },
        include: { replacedBy: true },
      });
      expect(old.revokedAt?.toISOString()).toBe('2026-11-02T03:20:00.000Z');
      expect(old.replacedBy?.tokenHash).toBe(sha256(next));
      expect(old.replacedBy?.revokedAt).toBeNull();

      // The successor rotates too.
      expect((await refresh(next)).status).toBe(200);
    });

    it('reuse of a rotated token → 401 REFRESH_TOKEN_REUSED and every session is revoked', async () => {
      const { email, session, refreshToken: first } = await signUp();
      const otherDevice = refreshTokenOf(await login(email));
      const second = refreshTokenOf(await refresh(first));

      const reuse = await refresh(first);

      expect(reuse.status).toBe(401);
      expect(errorOf(reuse).code).toBe('REFRESH_TOKEN_REUSED');
      expectCookieCleared(reuse);
      await expect(liveTokenCount(session.user.id)).resolves.toBe(0);
      for (const token of [second, otherDevice]) {
        const res = await refresh(token);
        expect(res.status).toBe(401);
        expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
      }
    });

    it('401 REFRESH_TOKEN_EXPIRED after 7 days (FakeClock)', async () => {
      const { refreshToken } = await signUp();

      clock.advance({ hours: 7 * 24 });
      const res = await refresh(refreshToken);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_EXPIRED');
      expectCookieCleared(res);
    });

    it('401 REFRESH_TOKEN_MISSING without a cookie', async () => {
      const res = await refresh();

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_MISSING');
    });

    it('401 REFRESH_TOKEN_INVALID for an unknown token, and clears the cookie', async () => {
      const res = await refresh('this-token-was-never-issued');

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
      expectCookieCleared(res);
    });

    it('10 concurrent refreshes of one token → exactly one 200 and no live token left', async () => {
      const { session, refreshToken } = await signUp();

      const responses = await Promise.all(Array.from({ length: 10 }, () => refresh(refreshToken)));

      const ok = responses.filter((res) => res.status === 200);
      const rejected = responses.filter((res) => res.status !== 200);
      expect(ok).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const res of rejected) {
        expect(res.status).toBe(401);
        expect(errorOf(res).code).toBe('REFRESH_TOKEN_REUSED');
      }
      // The winner's token was revoked too: the race is indistinguishable from theft.
      await expect(liveTokenCount(session.user.id)).resolves.toBe(0);
      // Losers rolled back their own successor rows: only the original + the winner's exist.
      await expect(
        db.prisma.refreshToken.count({ where: { userId: session.user.id } }),
      ).resolves.toBe(2);
    });
  });

  describe('logout', () => {
    it('204, clears the cookie, revokes this session only', async () => {
      const { email, session, refreshToken } = await signUp();
      const otherDevice = refreshTokenOf(await login(email));

      const res = await logout(refreshToken);

      expect(res.status).toBe(204);
      expectCookieCleared(res);
      const after = await refresh(refreshToken);
      expect(after.status).toBe(401);
      expect(errorOf(after).code).toBe('REFRESH_TOKEN_INVALID');
      // Logout is not a theft signal: the other device keeps working.
      expect((await refresh(otherDevice)).status).toBe(200);
      await expect(liveTokenCount(session.user.id)).resolves.toBe(1);
    });

    it('is idempotent: twice, unknown token, or no cookie → 204', async () => {
      const { refreshToken } = await signUp();

      expect((await logout(refreshToken)).status).toBe(204);
      expect((await logout(refreshToken)).status).toBe(204);
      expect((await logout('unknown-token')).status).toBe(204);
      expect((await logout()).status).toBe(204);
    });
  });

  // ─── 1.3 Login rate limit ───

  describe('login rate limit', () => {
    const expectTooMany = (res: Response) => {
      expect(res.status).toBe(429);
      const error = errorOf(res);
      expect(error.code).toBe('TOO_MANY_ATTEMPTS');
      const { retryAfterSeconds } = error.details as { retryAfterSeconds: number };
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(900);
    };

    it(`per email: ${LOGIN_MAX} attempts, then 429 even with the right password`, async () => {
      const { email } = await signUp();

      for (let i = 0; i < LOGIN_MAX; i++) {
        expect((await login(email, 'wrong password!')).status).toBe(401);
      }
      expectTooMany(await login(email));
      // Same email, other casing → same counter.
      expectTooMany(await login(email.toUpperCase()));

      const keys = await redis.client.keys('*');
      expect(keys).toContain(`rl:login:email:${sha256(email)}`);
      expect(keys.join(' ')).not.toContain(email);
    });

    it(`per IP: ${IP_MAX} attempts across many emails, then 429`, async () => {
      const responses = await Promise.all(
        Array.from({ length: IP_MAX }, () => login(uniqueEmail(), 'wrong password!')),
      );
      expect(responses.every((res) => res.status === 401)).toBe(true);

      expectTooMany(await login(uniqueEmail(), 'wrong password!'));
    });

    it('per IP: a spoofed X-Forwarded-For is ignored by default (TRUST_PROXY=false)', async () => {
      const responses = await Promise.all(
        Array.from({ length: IP_MAX }, (_, i) =>
          login(uniqueEmail(), 'wrong password!').set('X-Forwarded-For', `203.0.113.${i + 1}`),
        ),
      );
      expect(responses.every((res) => res.status === 401)).toBe(true);

      expectTooMany(
        await login(uniqueEmail(), 'wrong password!').set('X-Forwarded-For', '198.51.100.7'),
      );
      const keys = await redis.client.keys('rl:login:ip:*');
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/127\.0\.0\.1$/);
    });

    it('a successful login resets the email counter', async () => {
      const { email } = await signUp();
      for (let i = 0; i < LOGIN_MAX - 1; i++) await login(email, 'wrong password!');

      expect((await login(email)).status).toBe(200);

      for (let i = 0; i < LOGIN_MAX; i++) {
        expect((await login(email, 'wrong password!')).status).toBe(401);
      }
      expectTooMany(await login(email, 'wrong password!'));
    });

    it('fails open: login still works when Redis is down', async () => {
      const { email } = await signUp();
      const deadRedis = new Redis(DEAD_REDIS, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      deadRedis.on('error', () => undefined);
      const degraded = await startApp((builder) =>
        builder.overrideProvider(REDIS).useValue(deadRedis),
      );

      try {
        for (let i = 0; i < LOGIN_MAX + 2; i++) {
          const res = await request(degraded.getHttpServer())
            .post('/auth/login')
            .send({ email, password: 'wrong password!' });
          expect(res.status).toBe(401);
        }
        const ok = await request(degraded.getHttpServer())
          .post('/auth/login')
          .send({ email, password: PASSWORD });
        expect(ok.status).toBe(200);
      } finally {
        await degraded.close();
      }
    });
  });
});
