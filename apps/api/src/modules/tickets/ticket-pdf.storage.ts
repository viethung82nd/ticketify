import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CatalogErrorCode,
  TICKET_LIMITS,
  type TicketPdfLink,
  ticketPdfKey,
} from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { ObjectStorage, StorageUnavailableError } from '../../infra/storage/object-storage';

const PDF_CONTENT_TYPE = 'application/pdf';

const storageUnavailable = () =>
  apiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    CatalogErrorCode.STORAGE_UNAVAILABLE,
    'File storage is temporarily unavailable, please try again later',
  );

/**
 * The ticket PDF of a booking in object storage (ROADMAP 4.5).
 *
 * One fixed key per booking, `tickets/{bookingId}.pdf`: the worker may run `generate-pdf` again
 * after a crash, and overwriting the same key with the same bytes is the whole point — no
 * `-1.pdf` copies to clean up, and the link in an email that was already sent keeps working. An
 * S3 PUT replaces an object atomically, so a download during a rewrite gets the old file or the
 * new one, never half of either.
 *
 * Nothing here decides who may download: the controller checks that first.
 */
@Injectable()
export class TicketPdfStorage {
  private readonly logger = new Logger(TicketPdfStorage.name);

  constructor(private readonly storage: ObjectStorage) {}

  readonly keyOf = ticketPdfKey;

  /** Writes (or rewrites) the PDF of one booking. Throws `StorageUnavailableError` as it comes. */
  async save(bookingId: string, pdf: Buffer): Promise<string> {
    const key = ticketPdfKey(bookingId);
    await this.storage.putObject({ key, body: pdf, contentType: PDF_CONTENT_TYPE });
    this.logger.debug(`Ticket PDF of booking ${bookingId}: ${pdf.length} bytes at ${key}`);
    return key;
  }

  /** `true` once the object exists. `503 STORAGE_UNAVAILABLE` if the store cannot be reached. */
  async exists(bookingId: string): Promise<boolean> {
    return (await this.guard(() => this.storage.headObject(ticketPdfKey(bookingId)))) !== null;
  }

  /**
   * The stored PDF of one booking, or `null` when it is not there. Used by `send-email` to attach
   * exactly the file the download link serves, rather than a second rendering of it.
   */
  read(bookingId: string): Promise<Buffer | null> {
    return this.guard(() => this.storage.getObject(ticketPdfKey(bookingId)));
  }

  /** A short-lived presigned GET of the booking's PDF. The caller has checked who is asking. */
  async link(bookingId: string): Promise<TicketPdfLink> {
    const expiresIn = TICKET_LIMITS.pdfUrlTtlSeconds;
    const url = await this.guard(() =>
      this.storage.presignDownload(ticketPdfKey(bookingId), expiresIn),
    );
    return { url, expiresIn };
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
