import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createTestRedis, type TestRedis } from '../support/redis';

/** Nothing listens on port 1, so connections are refused immediately. */
const DEAD_POSTGRES = 'postgresql://nobody:nothing@127.0.0.1:1/none';
const DEAD_REDIS = 'redis://127.0.0.1:1';

interface HealthBody {
  status?: string;
  statusCode?: number;
  code?: string;
  details: Record<string, { status: string }>;
}

describe('GET /health (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let REDIS: symbol;
  let PrismaService: abstract new (...args: never[]) => unknown;
  let AppModule: new () => unknown;

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    // ConfigModule reads process.env when the module graph is first imported.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGINS: 'http://localhost:5173',
      DATABASE_URL: db.url,
      REDIS_URL: redis.url,
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'test',
      S3_SECRET_KEY: 'test-secret',
      S3_BUCKET: 'test-bucket',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_FROM: 'test@ticketify.local',
      JWT_ACCESS_SECRET: 'integration-test-access-secret-0123456789',
    });
    ({ AppModule } = await import('../../src/app.module.js'));
    ({ REDIS } = await import('../../src/infra/redis/redis.module.js'));
    ({ PrismaService } = await import('../../src/infra/prisma/prisma.service.js'));
  });

  afterAll(async () => {
    await Promise.all([db.drop(), redis.close()]);
  });

  async function startApp(
    override?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
  ): Promise<INestApplication<App>> {
    const builder = Test.createTestingModule({ imports: [AppModule] });
    override?.(builder);
    const app = (await builder.compile()).createNestApplication<INestApplication<App>>({
      logger: false,
    });
    await app.init();
    return app;
  }

  async function getHealth(app: INestApplication<App>) {
    try {
      const res = await request(app.getHttpServer()).get('/health');
      return { status: res.status, body: res.body as HealthBody };
    } finally {
      await app.close();
    }
  }

  it('returns 200 when Postgres and Redis are up', async () => {
    const { status, body } = await getHealth(await startApp());

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.details).toEqual({ database: { status: 'up' }, redis: { status: 'up' } });
  });

  it('returns 503 when Redis is down', async () => {
    const deadRedis = new Redis(DEAD_REDIS, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    deadRedis.on('error', () => undefined);

    const { status, body } = await getHealth(
      await startApp((builder) => builder.overrideProvider(REDIS).useValue(deadRedis)),
    );

    expect(status).toBe(503);
    expect(body).toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(body.details.database?.status).toBe('up');
    expect(body.details.redis?.status).toBe('down');
  });

  it('returns 503 when Postgres is down', async () => {
    const deadPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DEAD_POSTGRES, connectionTimeoutMillis: 1_000 }),
    });

    const { status, body } = await getHealth(
      await startApp((builder) => builder.overrideProvider(PrismaService).useValue(deadPrisma)),
    );
    await deadPrisma.$disconnect();

    expect(status).toBe(503);
    expect(body.details.database?.status).toBe('down');
    expect(body.details.redis?.status).toBe('up');
  });
});
