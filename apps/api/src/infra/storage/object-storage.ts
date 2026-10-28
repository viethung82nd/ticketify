/** Metadata of a stored object (what `HEAD` returns). */
export interface ObjectHead {
  contentType: string | undefined;
  contentLength: number | undefined;
}

export interface PresignUploadInput {
  key: string;
  /** Signed into the URL: the PUT must send exactly this `Content-Type`. */
  contentType: string;
  /** Signed into the URL: the PUT must send exactly this many bytes. */
  contentLength: number;
  expiresInSeconds: number;
}

/**
 * Port to the object store (S3 API; RustFS in dev). Business code depends on this abstract
 * class, never on the AWS SDK, so tests can swap in `FakeObjectStorage`.
 *
 * Presigning is local (HMAC over the request) and never touches the network. Methods that do
 * reach the store throw `StorageUnavailableError` when it cannot be reached or answers 5xx.
 */
export abstract class ObjectStorage {
  abstract presignUpload(input: PresignUploadInput): Promise<string>;

  abstract presignDownload(key: string, expiresInSeconds: number): Promise<string>;

  /** `null` when the object does not exist. */
  abstract headObject(key: string): Promise<ObjectHead | null>;

  /** Deleting a missing object succeeds (S3 semantics). */
  abstract deleteObject(key: string): Promise<void>;
}

/** The object store could not be reached or failed; the message never reaches clients. */
export class StorageUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Object storage ${operation} failed`, { cause });
    this.name = 'StorageUnavailableError';
  }
}
