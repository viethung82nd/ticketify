import {
  type ObjectHead,
  ObjectStorage,
  type PresignUploadInput,
  StorageUnavailableError,
} from '../object-storage';

/**
 * In-memory `ObjectStorage` for tests. Presigned URLs are readable fake strings; objects are
 * added with `put()` (standing in for the browser's PUT). `down = true` simulates an outage.
 */
export class FakeObjectStorage extends ObjectStorage {
  readonly objects = new Map<string, ObjectHead>();
  readonly deleted: string[] = [];
  readonly uploads: PresignUploadInput[] = [];
  down = false;
  /** Makes `deleteObject` fail while everything else works. */
  failDeletes = false;

  put(key: string, head: { contentType: string; contentLength: number }): void {
    this.objects.set(key, head);
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
    this.deleted.push(key);
    return Promise.resolve();
  }
}
