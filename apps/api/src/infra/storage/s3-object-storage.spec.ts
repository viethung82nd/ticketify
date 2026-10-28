import { testConfig } from '../../config/testing/test-config';
import { FakeClock } from '../clock/testing/fake-clock';
import { S3ObjectStorage } from './s3-object-storage';

/** Presigning is local HMAC work: no server is needed to check what gets signed. */
describe('S3ObjectStorage presigning', () => {
  const clock = new FakeClock('2026-11-02T03:04:05.000Z');
  const storage = new S3ObjectStorage(
    testConfig({ S3_ENDPOINT: 'http://localhost:9000', S3_BUCKET: 'posters-bucket' }),
    clock,
  );

  afterAll(() => storage.onModuleDestroy());

  it('signs Content-Type and Content-Length into the upload URL, without checksums', async () => {
    const url = new URL(
      await storage.presignUpload({
        key: 'posters/a.png',
        contentType: 'image/png',
        contentLength: 1234,
        expiresInSeconds: 300,
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(
      'http://localhost:9000/posters-bucket/posters/a.png',
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261102T030405Z');
    expect([...url.searchParams.keys()].filter((key) => /checksum/i.test(key))).toEqual([]);
  });

  describe('with S3_PUBLIC_ENDPOINT', () => {
    const publicStorage = new S3ObjectStorage(
      testConfig({
        S3_ENDPOINT: 'http://s3:9000',
        S3_PUBLIC_ENDPOINT: 'https://files.example.com',
        S3_BUCKET: 'posters-bucket',
      }),
      clock,
    );

    afterAll(() => publicStorage.onModuleDestroy());

    it('signs browser URLs for the public origin, not the internal one', async () => {
      const upload = new URL(
        await publicStorage.presignUpload({
          key: 'posters/a.png',
          contentType: 'image/png',
          contentLength: 1,
          expiresInSeconds: 300,
        }),
      );
      const download = new URL(await publicStorage.presignDownload('posters/a.png', 3600));

      for (const url of [upload, download]) {
        expect(url.origin).toBe('https://files.example.com');
        expect(url.pathname).toBe('/posters-bucket/posters/a.png');
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
      }
    });
  });

  it('signs a GET with the requested lifetime', async () => {
    const url = new URL(await storage.presignDownload('posters/a.png', 3600));

    expect(url.pathname).toBe('/posters-bucket/posters/a.png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});
