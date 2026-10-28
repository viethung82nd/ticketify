import { randomBytes, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type AdminMovie, type Movie, type PosterUpload, Role } from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';
import { EXTERNAL_S3_ENV, RUSTFS_IMAGE } from '../support/test-env';

const ACCESS_KEY = process.env[EXTERNAL_S3_ENV.accessKey] ?? 'ticketify';
const SECRET_KEY = process.env[EXTERNAL_S3_ENV.secretKey] ?? 'ticketify-secret';
const REGION = 'us-east-1';
/** Nothing listens on port 1: connections are refused immediately. */
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

/**
 * The same server under another name (localhost <-> 127.0.0.1), used as S3_PUBLIC_ENDPOINT:
 * the API talks to one host while "browsers" (fetch) use the other, as with an internal Docker
 * name and a public domain. A URL signed for the wrong host would fail with 403.
 */
function otherHostFor(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  else if (parsed.hostname === '127.0.0.1') parsed.hostname = 'localhost';
  else return undefined;
  return parsed.origin;
}

/**
 * The real upload path: API presigns → the "browser" (fetch) PUTs straight to RustFS →
 * the API verifies the object → posterUrl serves the same bytes.
 * Uses a RustFS container, or TEST_S3_ENDPOINT when a server is already running.
 */
describe('Poster storage (real RustFS)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  /** Our own container; `undefined` when using TEST_S3_ENDPOINT. */
  let rustfs: StartedTestContainer | undefined;
  let containerStopped = false;
  let s3: S3Client;
  let endpoint: string;
  let publicEndpoint: string | undefined;
  let app: INestApplication<App>;
  let adminToken: string;
  const bucket = `ticketify-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const external = process.env[EXTERNAL_S3_ENV.endpoint];
    const [database, testRedis, container] = await Promise.all([
      createTestDatabase(),
      createTestRedis(),
      external
        ? Promise.resolve(undefined)
        : new GenericContainer(RUSTFS_IMAGE)
            .withEnvironment({
              RUSTFS_ACCESS_KEY: ACCESS_KEY,
              RUSTFS_SECRET_KEY: SECRET_KEY,
              RUSTFS_VOLUMES: '/data',
              RUSTFS_ADDRESS: '0.0.0.0:9000',
            })
            .withExposedPorts(9000)
            .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200))
            .start(),
    ]);
    [db, redis, rustfs] = [database, testRedis, container];
    endpoint = external ?? `http://${container?.getHost()}:${container?.getMappedPort(9000)}`;
    publicEndpoint = otherHostFor(endpoint);

    s3 = new S3Client({
      endpoint,
      region: REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          S3_ENDPOINT: endpoint,
          S3_PUBLIC_ENDPOINT: publicEndpoint ?? '',
          S3_REGION: REGION,
          S3_ACCESS_KEY: ACCESS_KEY,
          S3_SECRET_KEY: SECRET_KEY,
          S3_BUCKET: bucket,
          S3_FORCE_PATH_STYLE: 'true',
        },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (rustfs) {
      if (!containerStopped) await rustfs.stop();
    } else if (s3) {
      // Shared external server: leave it as we found it.
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const objects = (listed.Contents ?? []).flatMap((item) =>
        item.Key ? [{ Key: item.Key }] : [],
      );
      if (objects.length > 0) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    s3?.destroy();
    await Promise.all([db?.drop(), redis?.close()]);
  }, 60_000);

  // ─── Helpers ───

  const admin = () => ({
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body),
    delete: (path: string) =>
      request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${adminToken}`),
  });

  async function presign(contentType: string, sizeBytes: number): Promise<PosterUpload> {
    const res = await admin().post('/admin/uploads/poster', { contentType, sizeBytes });
    expect(res.status).toBe(201);
    const upload = bodyOf<PosterUpload>(res);
    // Signed for the browser-facing host, while HEAD/DELETE go to S3_ENDPOINT.
    if (publicEndpoint) expect(new URL(upload.uploadUrl).origin).toBe(publicEndpoint);
    return upload;
  }

  /** What the browser does with the presigned URL. */
  const put = (url: string, contentType: string, body: Buffer) =>
    fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body });

  async function uploadPoster(contentType = 'image/png', bytes = randomBytes(4096)) {
    const upload = await presign(contentType, bytes.length);
    const res = await put(upload.uploadUrl, contentType, bytes);
    expect(res.status).toBe(200);
    return { key: upload.key, bytes };
  }

  const movieInput = (posterKey: string | null) => ({
    title: `Phim ${randomUUID().slice(0, 8)}`,
    duration: 100,
    ageRating: 'P',
    status: 'NOW_SHOWING',
    releaseDate: '2026-11-01',
    genreIds: [],
    posterKey,
  });

  async function createMovie(posterKey: string | null): Promise<AdminMovie> {
    const res = await admin().post('/admin/movies', movieInput(posterKey));
    expect(res.status).toBe(201);
    return bodyOf<AdminMovie>(res);
  }

  const exists = async (key: string): Promise<boolean> => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  };

  // ─── Tests ───

  it('exercises S3_PUBLIC_ENDPOINT against our own container', () => {
    if (rustfs) expect(publicEndpoint).toBeDefined();
  });

  it('presign → PUT → save movie → posterUrl serves the same bytes', async () => {
    const { key, bytes } = await uploadPoster('image/webp');
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(head.ContentType).toBe('image/webp');
    expect(head.ContentLength).toBe(bytes.length);

    const movie = await createMovie(key);
    expect(movie.posterKey).toBe(key);

    const detail = await request(app.getHttpServer()).get(`/movies/${movie.slug}`);
    const posterUrl = bodyOf<Movie>(detail).posterUrl;
    expect(posterUrl).toContain('X-Amz-Expires=3600');
    if (publicEndpoint) expect(new URL(posterUrl ?? '').origin).toBe(publicEndpoint);

    const download = await fetch(posterUrl ?? '');
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('the store rejects a PUT with another Content-Type or size than was signed', async () => {
    const bytes = randomBytes(1000);
    const upload = await presign('image/png', bytes.length);

    expect((await put(upload.uploadUrl, 'image/jpeg', bytes)).status).toBe(403);
    expect((await put(upload.uploadUrl, 'image/png', randomBytes(1001))).status).toBe(403);
    expect((await put(upload.uploadUrl, 'image/png', randomBytes(999))).status).toBe(403);
    expect(await exists(upload.key)).toBe(false);

    // Nothing landed, so the key cannot be attached to a movie.
    const res = await admin().post('/admin/movies', movieInput(upload.key));
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('POSTER_NOT_UPLOADED');
  });

  it('the API refuses to presign files over 2 MB or of other types', async () => {
    const tooBig = await admin().post('/admin/uploads/poster', {
      contentType: 'image/png',
      sizeBytes: 2 * 1024 * 1024 + 1,
    });
    const gif = await admin().post('/admin/uploads/poster', {
      contentType: 'image/gif',
      sizeBytes: 100,
    });

    expect([tooBig.status, gif.status]).toEqual([400, 400]);
  });

  it('replacing the poster and deleting the movie remove the old objects', async () => {
    const first = await uploadPoster();
    const second = await uploadPoster('image/jpeg');
    const movie = await createMovie(first.key);

    const res = await admin().patch(`/admin/movies/${movie.id}`, { posterKey: second.key });
    expect(res.status).toBe(200);
    expect(await exists(first.key)).toBe(false);
    expect(await exists(second.key)).toBe(true);

    expect((await admin().delete(`/admin/movies/${movie.id}`)).status).toBe(204);
    expect(await exists(second.key)).toBe(false);
  });

  // Keep last: it takes the store down for the rest of the suite.
  describe('storage outage', () => {
    let posterKey: string;
    let movieWithPoster: AdminMovie;
    let target: INestApplication<App>;

    beforeAll(async () => {
      posterKey = (await uploadPoster()).key;
      movieWithPoster = await createMovie((await uploadPoster()).key);

      if (rustfs) {
        await rustfs.stop();
        containerStopped = true;
        target = app;
      } else {
        // Cannot stop a shared server: point a second app at a dead endpoint instead.
        const { AppModule } = await import('../../src/app.module.js');
        const { ObjectStorage } = await import('../../src/infra/storage/object-storage.js');
        const { S3ObjectStorage } = await import('../../src/infra/storage/s3-object-storage.js');
        const { testConfig } = await import('../../src/config/testing/test-config.js');
        const { SystemClock } = await import('../../src/infra/clock/system-clock.js');
        const deadStorage = new S3ObjectStorage(
          testConfig({ S3_ENDPOINT: DEAD_ENDPOINT, S3_BUCKET: bucket }),
          new SystemClock(),
        );
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(ObjectStorage)
          .useValue(deadStorage)
          .compile();
        target = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
        await target.init();
      }
    }, 60_000);

    afterAll(async () => {
      if (target !== app) await target?.close();
    });

    const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${adminToken}`);

    it('saving a movie with a poster → 503 STORAGE_UNAVAILABLE, no SDK details', async () => {
      const res = await asAdmin(
        request(target.getHttpServer()).post('/admin/movies').send(movieInput(posterKey)),
      );

      expect(res.status).toBe(503);
      expect(errorOf(res).code).toBe('STORAGE_UNAVAILABLE');
      expect(errorOf(res).details).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|aws|sdk|127\.0\.0\.1/i);
    });

    it('reads still work (posterUrl is signed locally) and deleting only logs', async () => {
      const list = await request(target.getHttpServer()).get('/movies');
      expect(list.status).toBe(200);

      const res = await asAdmin(
        request(target.getHttpServer()).delete(`/admin/movies/${movieWithPoster.id}`),
      );
      expect(res.status).toBe(204);
    });
  });
});
