import { Logger } from '@nestjs/common';
import { CATALOG_LIMITS, isPosterKey } from '@ticketify/shared';
import { asyncHttpErrorOf } from '../../common/errors/testing/http-error';
import { StorageService } from './storage.service';
import { FakeObjectStorage } from './testing/fake-object-storage';

const KEY = 'posters/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png';
const TWO_MB = CATALOG_LIMITS.posterMaxBytes;

describe('isPosterKey', () => {
  it.each([
    KEY,
    'posters/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.jpg',
    'posters/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.webp',
  ])('accepts %s', (key) => {
    expect(isPosterKey(key)).toBe(true);
  });

  it.each([
    'avatars/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png',
    '0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png',
    '/posters/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png',
    'posters/../users/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png',
    'posters/../../etc/passwd',
    'posters/..%2F0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png',
    'posters/sub/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png',
    'posters/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.gif',
    'posters/0F8E8B3C-8D2A-4C1E-9A6B-2F4D5E6A7B8C.png',
    'posters/my-poster.png',
    `${KEY}\n`,
  ])('rejects %j', (key) => {
    expect(isPosterKey(key)).toBe(false);
  });
});

describe('StorageService (fake ObjectStorage)', () => {
  let storage: FakeObjectStorage;
  let service: StorageService;

  beforeEach(() => {
    storage = new FakeObjectStorage();
    service = new StorageService(storage);
  });

  describe('presignPosterUpload', () => {
    it.each([
      ['image/jpeg', 'jpg'],
      ['image/png', 'png'],
      ['image/webp', 'webp'],
    ] as const)('signs a 5-minute PUT for exactly %s and the declared size', async (type, ext) => {
      const upload = await service.presignPosterUpload(type, 123_456);

      expect(upload.key).toMatch(new RegExp(`^posters/[0-9a-f-]{36}\\.${ext}$`));
      expect(isPosterKey(upload.key)).toBe(true);
      expect(upload.expiresIn).toBe(300);
      expect(storage.uploads).toEqual([
        { key: upload.key, contentType: type, contentLength: 123_456, expiresInSeconds: 300 },
      ]);
      expect(upload.uploadUrl).toContain(upload.key);
    });

    it('generates a new key every time (clients never choose keys)', async () => {
      const a = await service.presignPosterUpload('image/png', 1);
      const b = await service.presignPosterUpload('image/png', 1);

      expect(a.key).not.toBe(b.key);
    });
  });

  describe('verifyPoster', () => {
    it('passes when the object exists with the matching type and an allowed size', async () => {
      storage.put(KEY, { contentType: 'image/png', contentLength: TWO_MB });

      await expect(service.verifyPoster(KEY)).resolves.toBeUndefined();
    });

    it.each([
      ['a key outside posters/', 'avatars/0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png', 'invalid_key'],
      ['path traversal', 'posters/../0f8e8b3c-8d2a-4c1e-9a6b-2f4d5e6a7b8c.png', 'invalid_key'],
      ['an object that was never uploaded', KEY, 'missing'],
    ])('rejects %s with 422 POSTER_NOT_UPLOADED', async (_case, key, reason) => {
      const error = await asyncHttpErrorOf(service.verifyPoster(key));

      expect(error).toEqual({
        status: 422,
        code: 'POSTER_NOT_UPLOADED',
        details: { field: 'posterKey', reason },
      });
    });

    it.each([
      ['another content type', { contentType: 'image/jpeg', contentLength: 100 }, 'content_type'],
      ['no content type', { contentType: undefined, contentLength: 100 }, 'content_type'],
      ['more than 2 MB', { contentType: 'image/png', contentLength: TWO_MB + 1 }, 'size'],
      ['an empty object', { contentType: 'image/png', contentLength: 0 }, 'size'],
    ])('rejects an object with %s', async (_case, head, reason) => {
      storage.objects.set(KEY, head);

      const error = await asyncHttpErrorOf(service.verifyPoster(KEY));

      expect(error).toMatchObject({
        status: 422,
        code: 'POSTER_NOT_UPLOADED',
        details: { reason },
      });
    });

    it('maps an unreachable store to 503 STORAGE_UNAVAILABLE without SDK details', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      storage.down = true;

      const error = await asyncHttpErrorOf(service.verifyPoster(KEY));

      expect(error).toEqual({ status: 503, code: 'STORAGE_UNAVAILABLE', details: undefined });
    });
  });

  describe('posterUrl', () => {
    it('is null without a poster and a 1-hour presigned GET otherwise', async () => {
      await expect(service.posterUrl(null)).resolves.toBeNull();
      await expect(service.posterUrl(KEY)).resolves.toBe(
        `https://fake-storage.test/${KEY}?expires=3600`,
      );
    });
  });

  describe('deleteQuietly', () => {
    it('deletes the object', async () => {
      storage.put(KEY, { contentType: 'image/png', contentLength: 1 });

      await service.deleteQuietly(KEY);

      expect(storage.deleted).toEqual([KEY]);
      expect(storage.objects.has(KEY)).toBe(false);
    });

    it('only logs a warning when the store fails', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      storage.failDeletes = true;

      await expect(service.deleteQuietly(KEY)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(KEY));
    });
  });
});
