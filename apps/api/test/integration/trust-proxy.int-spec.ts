import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

const LOGIN_MAX = 2;
const IP_MAX = LOGIN_MAX * 4;

/**
 * Behind a reverse proxy (TRUST_PROXY=loopback here: supertest connects from 127.0.0.1, playing
 * the proxy), the per-IP login limit must key on the client address from X-Forwarded-For.
 * Default behaviour (header ignored) is covered in auth.int-spec.ts.
 */
describe('TRUST_PROXY (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        { TRUST_PROXY: 'loopback', LOGIN_RATE_LIMIT_MAX: String(LOGIN_MAX) },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  let seq = 0;
  const attempt = (clientIp: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', clientIp)
      .send({ email: `proxy${++seq}@test.local`, password: 'wrong password!' });

  it('counts attempts per forwarded client IP, not per proxy', async () => {
    for (let i = 0; i < IP_MAX; i++) {
      expect((await attempt('203.0.113.10')).status).toBe(401);
    }

    const blocked = await attempt('203.0.113.10');
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked).code).toBe('TOO_MANY_ATTEMPTS');

    // Another client behind the same proxy is unaffected.
    expect((await attempt('203.0.113.20')).status).toBe(401);

    const keys = (await redis.client.keys('rl:login:ip:*')).sort();
    expect(keys).toEqual(['rl:login:ip:203.0.113.10', 'rl:login:ip:203.0.113.20']);
  });

  it('uses the right-most untrusted hop, so a client cannot prepend a fake address', async () => {
    // Client sends "X-Forwarded-For: 192.0.2.99"; the proxy appends the real peer 203.0.113.30.
    const res = await attempt('192.0.2.99, 203.0.113.30');

    expect(res.status).toBe(401);
    await expect(redis.client.exists('rl:login:ip:203.0.113.30')).resolves.toBe(1);
    await expect(redis.client.exists('rl:login:ip:192.0.2.99')).resolves.toBe(0);
  });
});
