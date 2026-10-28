import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CATALOG_LIMITS,
  CatalogErrorCode,
  isPosterKey,
  POSTER_CONTENT_TYPES,
  POSTER_KEY_PREFIX,
  type PosterContentType,
  posterContentTypeOfKey,
  type PosterUpload,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { ObjectStorage, StorageUnavailableError } from './object-storage';

const storageUnavailable = () =>
  apiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    CatalogErrorCode.STORAGE_UNAVAILABLE,
    'File storage is temporarily unavailable, please try again later',
  );

const posterNotUploaded = (reason: string) =>
  apiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    CatalogErrorCode.POSTER_NOT_UPLOADED,
    'Poster has not been uploaded',
    { field: 'posterKey', reason },
  );

/**
 * Poster files in object storage (PLAN §2: RustFS). Uploads go browser → storage directly:
 * 1. `presignPosterUpload` reserves a server-generated key and signs a short PUT for exactly
 *    that type and size;
 * 2. `verifyPoster` checks the object really landed before a movie may reference it.
 *
 * Storage outages surface as `503 STORAGE_UNAVAILABLE`, never as SDK details.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly storage: ObjectStorage) {}

  /** Validation of type and size is done by the DTO; this only signs. */
  async presignPosterUpload(
    contentType: PosterContentType,
    sizeBytes: number,
  ): Promise<PosterUpload> {
    const key = `${POSTER_KEY_PREFIX}${randomUUID()}.${POSTER_CONTENT_TYPES[contentType]}`;
    const expiresIn = CATALOG_LIMITS.posterUploadTtlSeconds;
    const uploadUrl = await this.guard(() =>
      this.storage.presignUpload({
        key,
        contentType,
        contentLength: sizeBytes,
        expiresInSeconds: expiresIn,
      }),
    );
    return { key, uploadUrl, expiresIn };
  }

  /**
   * `422 POSTER_NOT_UPLOADED` unless `key` is a server-shaped poster key whose object exists
   * with the type implied by its extension and an allowed size.
   */
  async verifyPoster(key: string): Promise<void> {
    const expectedType = isPosterKey(key) ? posterContentTypeOfKey(key) : undefined;
    if (!expectedType) throw posterNotUploaded('invalid_key');

    const head = await this.guard(() => this.storage.headObject(key));
    if (!head) throw posterNotUploaded('missing');
    if (head.contentType !== expectedType) throw posterNotUploaded('content_type');
    const size = head.contentLength ?? 0;
    if (size < 1 || size > CATALOG_LIMITS.posterMaxBytes) throw posterNotUploaded('size');
  }

  /** Presigned GET for a poster, or `null` without one. */
  posterUrl(key: string | null): Promise<string | null> {
    if (!key) return Promise.resolve(null);
    return this.guard(() => this.storage.presignDownload(key, CATALOG_LIMITS.posterUrlTtlSeconds));
  }

  /**
   * Best-effort cleanup after the database change committed: a failure leaves an orphan
   * object (logged) but must not fail the request that already succeeded.
   */
  async deleteQuietly(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not delete object ${key}: ${reason}`);
    }
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        this.logger.error(error.cause instanceof Error ? error.cause.message : error.message);
        throw storageUnavailable();
      }
      throw error;
    }
  }
}
