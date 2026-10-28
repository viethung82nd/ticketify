import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminGenre,
  type AdminMovie,
  type FieldError,
  type Genre,
  type Movie,
  type Page,
  type PosterUpload,
  Role,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ObjectStorage } from '../../src/infra/storage/object-storage';
import { FakeObjectStorage } from '../../src/infra/storage/testing/fake-object-storage';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createFixtures, type Fixtures } from '../support/fixtures';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

type Method = 'get' | 'post' | 'patch' | 'delete';

const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';

interface MovieInput {
  title: string;
  duration: number;
  ageRating: string;
  status: string;
  releaseDate: string;
  genreIds: string[];
  posterKey?: string | null;
}

describe('Movies & genres (real Postgres + Redis, fake object storage)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let fixtures: Fixtures;
  let storage: FakeObjectStorage;
  let app: INestApplication<App>;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    // ConfigModule reads process.env when the module graph is first imported.
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    const { AppModule } = await import('../../src/app.module.js');
    storage = new FakeObjectStorage();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ObjectStorage)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    // Listen on a real port so concurrent supertest requests share one server.
    await app.listen(0, '127.0.0.1');
    fixtures = createFixtures(db.prisma);
    [adminToken, userToken] = await Promise.all([
      accessTokenFor(app, db.prisma, Role.ADMIN),
      accessTokenFor(app, db.prisma, Role.USER),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => {
    storage.down = false;
    storage.failDeletes = false;
  });

  // ─── HTTP helpers ───

  const http = () => request(app.getHttpServer());

  const as = (token: string | undefined, method: Method, path: string, body?: object) => {
    const req = http()[method](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const admin = (method: Method, path: string, body?: object) => as(adminToken, method, path, body);

  /** Unique per call so tests can find their own rows with `q`. */
  const tag = () => `zx${randomUUID().slice(0, 6)}`;

  async function createGenre(name = `Thể loại ${tag()}`): Promise<Genre> {
    const res = await admin('post', '/admin/genres', { name });
    expect(res.status).toBe(201);
    return bodyOf<Genre>(res);
  }

  const movieInput = (overrides: Partial<MovieInput> = {}): MovieInput => ({
    title: `Phim ${tag()}`,
    duration: 100,
    ageRating: 'T13',
    status: 'NOW_SHOWING',
    releaseDate: '2026-11-01',
    genreIds: [],
    ...overrides,
  });

  async function createMovie(overrides: Partial<MovieInput> = {}): Promise<AdminMovie> {
    const res = await admin('post', '/admin/movies', movieInput(overrides));
    expect(res.status).toBe(201);
    return bodyOf<AdminMovie>(res);
  }

  /** What the browser does: presign, then PUT the file (the fake store records the object). */
  async function uploadPoster(contentType = 'image/png', sizeBytes = 2048): Promise<string> {
    const res = await admin('post', '/admin/uploads/poster', { contentType, sizeBytes });
    expect(res.status).toBe(201);
    const { key } = bodyOf<PosterUpload>(res);
    storage.put(key, { contentType, contentLength: sizeBytes });
    return key;
  }

  const listPublic = async (query: string) => {
    const res = await http().get(`/movies?${query}`);
    expect(res.status).toBe(200);
    return bodyOf<Page<Movie>>(res);
  };
  const titles = (page: Page<{ title: string }>) => page.items.map((movie) => movie.title);
  const fieldsOf = (details: unknown) => (details as FieldError[]).map((error) => error.field);

  // ─── Access control ───

  describe('role access', () => {
    // Every row has 3 items: with fewer, Jest would pass `done` as the missing argument.
    const adminRoutes: [Method, string, object | undefined][] = [
      ['get', '/admin/movies', undefined],
      ['get', `/admin/movies/${UNKNOWN_ID}`, undefined],
      ['post', '/admin/movies', {}],
      ['patch', `/admin/movies/${UNKNOWN_ID}`, {}],
      ['delete', `/admin/movies/${UNKNOWN_ID}`, undefined],
      ['get', '/admin/genres', undefined],
      ['post', '/admin/genres', { name: 'X' }],
      ['patch', `/admin/genres/${UNKNOWN_ID}`, { name: 'X' }],
      ['delete', `/admin/genres/${UNKNOWN_ID}`, undefined],
      ['post', '/admin/uploads/poster', { contentType: 'image/png', sizeBytes: 1 }],
    ];

    it.each(adminRoutes)('%s %s: 401 without a token, 403 for USER', async (method, path, body) => {
      const anonymous = await as(undefined, method, path, body);
      expect(anonymous.status).toBe(401);
      expect(errorOf(anonymous).code).toBe('UNAUTHORIZED');

      const user = await as(userToken, method, path, body);
      expect(user.status).toBe(403);
      expect(errorOf(user).code).toBe('FORBIDDEN');
    });

    it('public catalog routes need no token', async () => {
      const movie = await createMovie();

      expect((await http().get('/movies')).status).toBe(200);
      expect((await http().get(`/movies/${movie.slug}`)).status).toBe(200);
      expect((await http().get('/genres')).status).toBe(200);
    });
  });

  // ─── Genres ───

  describe('genres', () => {
    it('creates with a slug, lists by name, renames and deletes', async () => {
      const t = tag();
      const genre = await createGenre(`Hành Động ${t}`);
      expect(genre).toEqual({
        id: expect.any(String) as string,
        name: `Hành Động ${t}`,
        slug: `hanh-dong-${t}`,
      });

      const renamed = await admin('patch', `/admin/genres/${genre.id}`, { name: `Võ thuật ${t}` });
      expect(renamed.status).toBe(200);
      expect(bodyOf<Genre>(renamed).slug).toBe(`vo-thuat-${t}`);

      const names = bodyOf<Genre[]>(await http().get('/genres')).map((g) => g.name);
      const vi = new Intl.Collator('vi', { sensitivity: 'base' });
      expect(names).toEqual([...names].sort((a, b) => vi.compare(a, b)));
      expect(names).toContain(`Võ thuật ${t}`);

      expect((await admin('delete', `/admin/genres/${genre.id}`)).status).toBe(204);
      expect(await db.prisma.genre.count({ where: { id: genre.id } })).toBe(0);
    });

    it('rejects a duplicate name (also one differing only in accents or case) with 409', async () => {
      const t = tag();
      const genre = await createGenre(`Kinh dị ${t}`);
      const other = await createGenre();

      for (const name of [`Kinh dị ${t}`, `KINH DI ${t}`]) {
        const res = await admin('post', '/admin/genres', { name });
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('GENRE_NAME_TAKEN');
      }
      const rename = await admin('patch', `/admin/genres/${other.id}`, { name: genre.name });
      expect(rename.status).toBe(409);
      expect(errorOf(rename).code).toBe('GENRE_NAME_TAKEN');
    });

    it('404 GENRE_NOT_FOUND for unknown ids, 400 for malformed ones', async () => {
      const rename = await admin('patch', `/admin/genres/${UNKNOWN_ID}`, { name: 'X' });
      expect(rename.status).toBe(404);
      expect(errorOf(rename).code).toBe('GENRE_NOT_FOUND');
      expect(errorOf(await admin('delete', `/admin/genres/${UNKNOWN_ID}`)).code).toBe(
        'GENRE_NOT_FOUND',
      );
      expect((await admin('delete', '/admin/genres/not-a-uuid')).status).toBe(400);
    });

    it('cannot delete a genre in use: 409 GENRE_IN_USE, admin list shows the count', async () => {
      const genre = await createGenre();
      await createMovie({ genreIds: [genre.id] });

      const res = await admin('delete', `/admin/genres/${genre.id}`);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'GENRE_IN_USE', details: { movieCount: 1 } });
      expect(await db.prisma.genre.count({ where: { id: genre.id } })).toBe(1);

      const listed = bodyOf<AdminGenre[]>(await admin('get', '/admin/genres'));
      expect(listed.find((g) => g.id === genre.id)?.movieCount).toBe(1);
    });

    it('validates the name', async () => {
      const res = await admin('post', '/admin/genres', { name: '   ' });
      expect(res.status).toBe(400);
      expect(fieldsOf(errorOf(res).details)).toEqual(['name']);
    });
  });

  // ─── Movies CRUD ───

  describe('movie CRUD', () => {
    it('creates a movie with genres (201) and serves it by slug', async () => {
      const [a, b] = [await createGenre(), await createGenre()];
      const t = tag();
      const res = await admin(
        'post',
        '/admin/movies',
        movieInput({ title: `  Đất Rừng Phương Nam ${t} `, genreIds: [a.id, b.id] }),
      );

      expect(res.status).toBe(201);
      const created = bodyOf<AdminMovie>(res);
      expect(created).toMatchObject({
        title: `Đất Rừng Phương Nam ${t}`,
        slug: `dat-rung-phuong-nam-${t}`,
        duration: 100,
        ageRating: 'T13',
        status: 'NOW_SHOWING',
        releaseDate: '2026-11-01',
        posterKey: null,
        posterUrl: null,
      });
      expect(created.genres.map((g) => g.id).sort()).toEqual([a.id, b.id].sort());

      const detail = await http().get(`/movies/${created.slug}`);
      expect(detail.status).toBe(200);
      const movie = bodyOf<Movie>(detail);
      expect(movie.genres).toHaveLength(2);
      expect(movie).not.toHaveProperty('posterKey');

      const stored = await db.prisma.$queryRaw<{ release_date: string }[]>`
        SELECT release_date::text FROM movies WHERE id = ${created.id}::uuid`;
      expect(stored[0]?.release_date).toBe('2026-11-01');
    });

    it('404 MOVIE_NOT_FOUND for unknown slugs and ids', async () => {
      const bySlug = await http().get('/movies/khong-co-phim-nay');
      expect(bySlug.status).toBe(404);
      expect(errorOf(bySlug).code).toBe('MOVIE_NOT_FOUND');
      for (const method of ['get', 'patch', 'delete'] as const) {
        const res = await admin(
          method,
          `/admin/movies/${UNKNOWN_ID}`,
          method === 'patch' ? {} : undefined,
        );
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('MOVIE_NOT_FOUND');
      }
    });

    it('PATCH updates only what is sent; the slug survives a title change', async () => {
      const movie = await createMovie({ title: `Tên cũ ${tag()}` });

      const res = await admin('patch', `/admin/movies/${movie.id}`, {
        title: 'Tên mới',
        status: 'ENDED',
      });

      expect(res.status).toBe(200);
      expect(bodyOf<AdminMovie>(res)).toMatchObject({
        title: 'Tên mới',
        slug: movie.slug,
        status: 'ENDED',
        duration: movie.duration,
        releaseDate: movie.releaseDate,
      });
    });

    it('PATCH with an explicit slug changes it; a taken slug is 409 SLUG_TAKEN', async () => {
      const [a, b] = [await createMovie(), await createMovie()];
      const slug = `slug-moi-${tag()}`;

      const changed = await admin('patch', `/admin/movies/${a.id}`, { slug });
      expect(changed.status).toBe(200);
      expect(bodyOf<AdminMovie>(changed).slug).toBe(slug);
      expect((await http().get(`/movies/${slug}`)).status).toBe(200);

      const same = await admin('patch', `/admin/movies/${a.id}`, { slug });
      expect(same.status).toBe(200);

      const clash = await admin('patch', `/admin/movies/${b.id}`, { slug });
      expect(clash.status).toBe(409);
      expect(errorOf(clash)).toMatchObject({ code: 'SLUG_TAKEN', details: { field: 'slug' } });

      const invalid = await admin('patch', `/admin/movies/${b.id}`, { slug: 'Không Hợp Lệ' });
      expect(invalid.status).toBe(400);
    });

    it('PATCH genreIds replaces the genre set', async () => {
      const [a, b, c] = [await createGenre(), await createGenre(), await createGenre()];
      const movie = await createMovie({ genreIds: [a.id, b.id] });

      const res = await admin('patch', `/admin/movies/${movie.id}`, { genreIds: [c.id] });

      expect(res.status).toBe(200);
      expect(bodyOf<AdminMovie>(res).genres.map((g) => g.id)).toEqual([c.id]);
    });

    it('DELETE removes a movie without showtimes (204)', async () => {
      const movie = await createMovie();

      expect((await admin('delete', `/admin/movies/${movie.id}`)).status).toBe(204);
      expect((await http().get(`/movies/${movie.slug}`)).status).toBe(404);
    });

    it('DELETE of a movie with a showtime is 409 MOVIE_HAS_SHOWTIMES and keeps it', async () => {
      const movie = await createMovie();
      const room = await fixtures.room();
      // No showtime endpoint yet (task 1.13): insert directly.
      await fixtures.showtime({
        movieId: movie.id,
        roomId: room.id,
        startsAt: '2026-11-05T12:00:00Z',
        endsAt: '2026-11-05T14:00:00Z',
        status: 'CANCELLED',
      });

      const res = await admin('delete', `/admin/movies/${movie.id}`);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('MOVIE_HAS_SHOWTIMES');
      expect(await db.prisma.movie.count({ where: { id: movie.id } })).toBe(1);
    });
  });

  // ─── Validation ───

  describe('validation', () => {
    it.each([
      [
        'more than 5 genres',
        { genreIds: Array.from({ length: 6 }, () => randomUUID()) },
        'genreIds',
      ],
      ['duplicate genres', { genreIds: [UNKNOWN_ID, UNKNOWN_ID] }, 'genreIds'],
      ['a datetime as release date', { releaseDate: '2026-11-01T00:00:00Z' }, 'releaseDate'],
      ['an impossible date', { releaseDate: '2026-02-29' }, 'releaseDate'],
      ['a long title', { title: 'x'.repeat(201) }, 'title'],
      ['duration 0', { duration: 0 }, 'duration'],
      ['duration 401', { duration: 401 }, 'duration'],
      ['an unknown age rating', { ageRating: 'PG' }, 'ageRating'],
    ])('400 VALIDATION_FAILED for %s, on the right field', async (_case, override, field) => {
      const res = await admin('post', '/admin/movies', movieInput(override));

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(errorOf(res).details)).toEqual([field]);
    });

    it('422 INVALID_GENRES when a genre does not exist, listing the missing ids', async () => {
      const genre = await createGenre();
      const missing = randomUUID();

      const res = await admin(
        'post',
        '/admin/movies',
        movieInput({ genreIds: [genre.id, missing] }),
      );

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'INVALID_GENRES',
        details: { field: 'genreIds', genreIds: [missing] },
      });
    });

    it('400 for out-of-range paging', async () => {
      for (const query of ['pageSize=51', 'pageSize=0', 'page=0', 'page=abc']) {
        const res = await http().get(`/movies?${query}`);
        expect(res.status).toBe(400);
      }
    });
  });

  // ─── Slugs ───

  describe('slug generation', () => {
    it('suffixes -2, -3 for the same title', async () => {
      const title = `Trùng Tên ${tag()}`;
      const slugs: string[] = [];
      for (let i = 0; i < 3; i++) slugs.push((await createMovie({ title })).slug);

      const base = slugs[0] ?? '';
      expect(slugs).toEqual([base, `${base}-2`, `${base}-3`]);
    });

    it('falls back to "phim" for titles without Latin letters or digits', async () => {
      const movie = await createMovie({ title: '!!!' });
      expect(movie.slug).toMatch(/^phim(-\d+)?$/);
    });

    it('concurrent creates with the same title: no 5xx, all slugs distinct', async () => {
      const title = `Đồng Thời ${tag()}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () => admin('post', '/admin/movies', movieInput({ title }))),
      );

      expect(results.map((res) => res.status)).toEqual(Array(10).fill(201));
      const slugs = results.map((res) => bodyOf<AdminMovie>(res).slug);
      expect(new Set(slugs).size).toBe(10);
    });
  });

  // ─── Listing ───

  describe('list: filter, search, paging, order', () => {
    let t: string;
    let genre: Genre;

    beforeAll(async () => {
      t = tag();
      genre = await createGenre();
      const rows: Partial<MovieInput>[] = [
        { title: `Bình Minh ${t}`, releaseDate: '2026-10-01', genreIds: [genre.id] },
        { title: `An Nhiên ${t}`, releaseDate: '2026-10-01' },
        {
          title: `Cơn Mưa ${t}`,
          releaseDate: '2026-12-24',
          status: 'COMING_SOON',
          genreIds: [genre.id],
        },
        { title: `Dĩ Vãng ${t}`, releaseDate: '2025-01-01', status: 'ENDED', genreIds: [genre.id] },
        { title: `Em Và Trịnh ${t}`, releaseDate: '2026-11-15' },
      ];
      for (const row of rows) await createMovie(row);
    });

    it('hides ENDED by default; sorts by release date desc then title asc', async () => {
      const page = await listPublic(`q=${t}`);

      expect(titles(page)).toEqual([
        `Cơn Mưa ${t}`,
        `Em Và Trịnh ${t}`,
        `An Nhiên ${t}`,
        `Bình Minh ${t}`,
      ]);
      expect(page).toMatchObject({ total: 4, page: 1, pageSize: 12 });
    });

    it('returns ENDED only when asked for', async () => {
      expect(titles(await listPublic(`q=${t}&status=ENDED`))).toEqual([`Dĩ Vãng ${t}`]);
    });

    it('filters by status and by genre slug', async () => {
      expect(titles(await listPublic(`q=${t}&status=COMING_SOON`))).toEqual([`Cơn Mưa ${t}`]);
      expect(titles(await listPublic(`genre=${genre.slug}`))).toEqual([
        `Cơn Mưa ${t}`,
        `Bình Minh ${t}`,
      ]);
      expect((await listPublic('genre=khong-ton-tai')).total).toBe(0);
    });

    it('paginates with a stable order', async () => {
      const first = await listPublic(`q=${t}&pageSize=3&page=1`);
      const second = await listPublic(`q=${t}&pageSize=3&page=2`);
      const beyond = await listPublic(`q=${t}&pageSize=3&page=3`);

      expect(first).toMatchObject({ total: 4, page: 1, pageSize: 3 });
      expect(titles(first)).toHaveLength(3);
      expect(titles(second)).toEqual([`Bình Minh ${t}`]);
      expect(beyond.items).toEqual([]);
    });

    it('searches case- and accent-insensitively', async () => {
      for (const q of [`binh minh ${t}`, `BÌNH MINH ${t}`, `Bình   minh ${t}`, `inh mi`]) {
        const found = titles(await listPublic(`q=${encodeURIComponent(q)}`));
        expect(found).toContain(`Bình Minh ${t}`);
      }
      expect(
        titles(await listPublic(`q=${encodeURIComponent(`dĩ vãng ${t}`)}&status=ENDED`)),
      ).toEqual([`Dĩ Vãng ${t}`]);
    });

    it('treats LIKE wildcards in the search literally', async () => {
      expect((await listPublic('q=%25')).total).toBe(0);
      expect((await listPublic('q=_')).total).toBe(0);
    });

    it('admin list includes every status and defaults to 20 per page', async () => {
      const res = await admin('get', `/admin/movies?q=${t}`);

      expect(res.status).toBe(200);
      const page = bodyOf<Page<AdminMovie>>(res);
      expect(page).toMatchObject({ total: 5, pageSize: 20 });
      expect(page.items.map((m) => m.status)).toContain('ENDED');
    });

    it('public default page size is 12', async () => {
      expect((await listPublic('')).pageSize).toBe(12);
    });
  });

  // ─── Posters (fake storage) ───

  describe('posters', () => {
    it('presign rejects other types and files over 2 MB (400)', async () => {
      for (const body of [
        { contentType: 'image/gif', sizeBytes: 100 },
        { contentType: 'image/png', sizeBytes: 2 * 1024 * 1024 + 1 },
      ]) {
        const res = await admin('post', '/admin/uploads/poster', body);
        expect(res.status).toBe(400);
      }
    });

    it('accepts an uploaded poster and exposes a presigned posterUrl', async () => {
      const key = await uploadPoster();

      const movie = await createMovie({ posterKey: key });

      expect(movie.posterKey).toBe(key);
      expect(movie.posterUrl).toBe(`https://fake-storage.test/${key}?expires=3600`);
      const listed = await listPublic(`q=${encodeURIComponent(movie.title)}`);
      expect(listed.items[0]?.posterUrl).toBe(movie.posterUrl);
    });

    it.each([
      ['never uploaded', 'posters/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png'],
      ['outside posters/', 'avatars/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png'],
      ['path traversal', 'posters/../0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png'],
    ])('422 POSTER_NOT_UPLOADED for a key %s', async (_case, posterKey) => {
      const res = await admin('post', '/admin/movies', movieInput({ posterKey }));

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('POSTER_NOT_UPLOADED');
    });

    it('422 when the stored object does not match the declared type', async () => {
      const res = await admin('post', '/admin/uploads/poster', {
        contentType: 'image/png',
        sizeBytes: 100,
      });
      const { key } = bodyOf<PosterUpload>(res);
      storage.put(key, { contentType: 'text/html', contentLength: 100 });

      const create = await admin('post', '/admin/movies', movieInput({ posterKey: key }));
      expect(create.status).toBe(422);
    });

    it('replacing or removing a poster deletes the old object', async () => {
      const first = await uploadPoster();
      const second = await uploadPoster('image/webp');
      const movie = await createMovie({ posterKey: first });

      const replaced = await admin('patch', `/admin/movies/${movie.id}`, { posterKey: second });
      expect(replaced.status).toBe(200);
      expect(storage.deleted).toContain(first);
      expect(storage.objects.has(second)).toBe(true);

      const removed = await admin('patch', `/admin/movies/${movie.id}`, { posterKey: null });
      expect(removed.status).toBe(200);
      expect(bodyOf<AdminMovie>(removed).posterUrl).toBeNull();
      expect(storage.deleted).toContain(second);
    });

    it('keeps the object when another movie still uses the same key', async () => {
      const key = await uploadPoster();
      const a = await createMovie({ posterKey: key });
      await createMovie({ posterKey: key });

      await admin('patch', `/admin/movies/${a.id}`, { posterKey: null });

      expect(storage.deleted).not.toContain(key);
    });

    it('deleting a movie deletes its poster; a storage failure there is only logged', async () => {
      const key = await uploadPoster();
      const movie = await createMovie({ posterKey: key });
      storage.failDeletes = true;

      expect((await admin('delete', `/admin/movies/${movie.id}`)).status).toBe(204);
      expect(storage.objects.has(key)).toBe(true);

      storage.failDeletes = false;
      const other = await createMovie({ posterKey: await uploadPoster() });
      expect((await admin('delete', `/admin/movies/${other.id}`)).status).toBe(204);
      expect(storage.deleted).toContain(other.posterKey);
    });

    it('503 STORAGE_UNAVAILABLE when the store is down, without SDK details', async () => {
      const key = await uploadPoster();
      storage.down = true;

      const res = await admin('post', '/admin/movies', movieInput({ posterKey: key }));

      expect(res.status).toBe(503);
      expect(errorOf(res).code).toBe('STORAGE_UNAVAILABLE');
      expect(errorOf(res).details).toBeUndefined();
    });
  });
});
