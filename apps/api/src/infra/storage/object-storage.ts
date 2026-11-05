/** Metadata of a stored object (what `HEAD` returns). */
export interface ObjectHead {
  contentType: string | undefined;
  contentLength: number | undefined;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
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

  /**
   * Writes an object from the server itself (the ticket PDF, ROADMAP 4.5). Overwrites whatever
   * was at `key`: S3 PUT is atomic per object, so a reader either gets the whole old version or
   * the whole new one, never a half-written file. Used with a fixed key per booking, so a job
   * that runs twice replaces the file with the same bytes.
   */
  abstract putObject(input: PutObjectInput): Promise<void>;

  abstract presignDownload(key: string, expiresInSeconds: number): Promise<string>;

  /** `null` when the object does not exist. */
  abstract headObject(key: string): Promise<ObjectHead | null>;

  /**
   * Reads a whole object into memory; `null` when it does not exist. Only for files the server
   * put there itself and whose size it knows (the ticket PDF, tens of kilobytes) — never for
   * something a client uploaded.
   */
  abstract getObject(key: string): Promise<Buffer | null>;

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
