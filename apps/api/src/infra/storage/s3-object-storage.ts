import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { ClockService } from '../clock/clock.service';
import {
  type ObjectHead,
  ObjectStorage,
  type PresignUploadInput,
  StorageUnavailableError,
} from './object-storage';

/** Fail fast when the store is down instead of hanging the request. */
const CONNECTION_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The presigner leaves `content-type` unsigned by default. Signing it and `content-length`
 * makes the store reject a PUT whose type or size differs from what the API approved.
 */
const SIGNED_UPLOAD_HEADERS = new Set(['content-type', 'content-length']);

const statusOf = (error: unknown): number | undefined =>
  error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;

/** `ObjectStorage` over the AWS SDK v3, for any S3-compatible service (RustFS, MinIO, S3). */
@Injectable()
export class S3ObjectStorage extends ObjectStorage implements OnModuleDestroy {
  /** Server-to-store calls (HEAD, DELETE) on S3_ENDPOINT. */
  private readonly client: S3Client;
  /**
   * Signs URLs handed to browsers. A SigV4 signature covers the Host header, so it must be
   * made for the host the browser will call: S3_PUBLIC_ENDPOINT when set. Presigning is
   * local, so this client never opens a connection.
   */
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(
    config: AppConfig,
    private readonly clock: ClockService,
  ) {
    super();
    this.bucket = config.get('S3_BUCKET');
    this.client = S3ObjectStorage.createClient(config, config.get('S3_ENDPOINT'));
    const publicEndpoint = config.get('S3_PUBLIC_ENDPOINT');
    this.signer = publicEndpoint
      ? S3ObjectStorage.createClient(config, publicEndpoint)
      : this.client;
  }

  private static createClient(config: AppConfig, endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: config.get('S3_REGION'),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY'),
        secretAccessKey: config.get('S3_SECRET_KEY'),
      },
      // Newer SDKs add CRC32 checksum parameters to presigned PUTs, which browsers cannot
      // compute; only send checksums where the S3 API requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 2,
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      },
    });
  }

  presignUpload(input: PresignUploadInput): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    });
    return getSignedUrl(this.signer, command, {
      expiresIn: input.expiresInSeconds,
      signingDate: this.clock.now(),
      signableHeaders: SIGNED_UPLOAD_HEADERS,
    });
  }

  presignDownload(key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.signer, command, {
      expiresIn: expiresInSeconds,
      signingDate: this.clock.now(),
    });
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { contentType: head.ContentType, contentLength: head.ContentLength };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw new StorageUnavailableError('HEAD', error);
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw new StorageUnavailableError('DELETE', error);
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }
}
