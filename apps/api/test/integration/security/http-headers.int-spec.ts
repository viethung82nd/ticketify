import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppConfig } from '../../../src/config/app-config.service';
import { configureHttp } from '../../../src/http-setup';
import { appTestEnv } from '../../support/app-env';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { createTestRedis, type TestRedis } from '../../support/redis';

/** The web origin appTestEnv allows (CORS_ORIGINS). */
const WEB = 'http://localhost:5173';
const OTHER = 'https://evil.example';

/**
 * The HTTP protections main.ts applies through configureHttp (ROADMAP 6.5): helmet's headers and
 * the CORS allow-list. Every other suite builds the app without them, so they are checked here,
 * on a public route, a protected one and an error answer.
 */
describe('HTTP security headers and CORS (configureHttp)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    const { AppModule } = await import('../../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    configureHttp(app, app.get(AppConfig));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  it.each([
    ['a public route', '/movies', 200],
    ['a protected route without a token', '/me/bookings', 401],
    ['an unknown route', '/no-such-route', 404],
  ])('%s carries the helmet headers and no X-Powered-By', async (_, path, status) => {
    const res = await request(app.getHttpServer()).get(path);

    expect(res.status).toBe(status);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('answers the web origin with credentials and exposes Date', async () => {
    const res = await request(app.getHttpServer()).get('/movies').set('Origin', WEB);

    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe('Date');
  });

  it('a preflight from the web origin is allowed; one from another origin is not', async () => {
    const preflight = (origin: string) =>
      request(app.getHttpServer())
        .options('/bookings')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key');

    const allowed = await preflight(WEB);
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB);

    const refused = await preflight(OTHER);
    // No Access-Control-Allow-Origin, so the browser blocks the request. (The cors package still
    // sends Allow-Credentials, which grants nothing without an allowed origin.)
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('another origin gets no CORS grant on a simple request either', async () => {
    const res = await request(app.getHttpServer()).get('/movies').set('Origin', OTHER);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
