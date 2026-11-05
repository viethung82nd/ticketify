import {
  type ObjectHead,
  ObjectStorage,
  type PresignUploadInput,
  type PutObjectInput,
  StorageUnavailableError,
} from '../object-storage';

/**
 * In-memory `ObjectStorage` for tests. Presigned URLs are readable fake strings; objects are
 * added with `put()` (standing in for the browser's PUT). `down = true` simulates an outage.
 */
export class FakeObjectStorage extends ObjectStorage {
  readonly objects = new Map<string, ObjectHead>();
  /** Bytes written by `putObject`, by key: the last write wins, as in S3. */
  readonly bodies = new Map<string, Buffer>();
  /** Every `putObject` call, in order, so a test can see a job that ran twice. */
  readonly puts: PutObjectInput[] = [];
  readonly deleted: string[] = [];
  readonly uploads: PresignUploadInput[] = [];
  down = false;
  /** Makes `deleteObject` fail while everything else works. */
  failDeletes = false;

  put(key: string, head: { contentType: string; contentLength: number }): void {
    this.objects.set(key, head);
  }

  putObject(input: PutObjectInput): Promise<void> {
    if (this.down) return Promise.reject(new StorageUnavailableError('PUT', new Error('down')));
    this.puts.push(input);
    this.bodies.set(input.key, input.body);
    this.objects.set(input.key, {
      contentType: input.contentType,
      contentLength: input.body.length,
    });
    return Promise.resolve();
  }

  presignUpload(input: PresignUploadInput): Promise<string> {
    this.uploads.push(input);
    return Promise.resolve(
      `https://fake-storage.test/upload/${input.key}?type=${encodeURIComponent(input.contentType)}` +
        `&length=${input.contentLength}&expires=${input.expiresInSeconds}`,
    );
  }

  presignDownload(key: string, expiresInSeconds: number): Promise<string> {
    return Promise.resolve(`https://fake-storage.test/${key}?expires=${expiresInSeconds}`);
  }

  headObject(key: string): Promise<ObjectHead | null> {
    if (this.down) return Promise.reject(new StorageUnavailableError('HEAD', new Error('down')));
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  deleteObject(key: string): Promise<void> {
    if (this.down || this.failDeletes) {
      return Promise.reject(new StorageUnavailableError('DELETE', new Error('down')));
    }
    this.objects.delete(key);
    this.bodies.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
  }
}
