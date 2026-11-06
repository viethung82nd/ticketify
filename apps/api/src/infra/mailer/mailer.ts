/** One file attached to an outgoing message. */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  /** The HTML body. */
  html: string;
  /** Plain-text alternative, for clients that refuse HTML. */
  text: string;
  attachments?: MailAttachment[];
}

/**
 * Port to the mail server (SMTP; Mailpit in development). Business code depends on this abstract
 * class, never on Nodemailer, so tests can swap in `FakeMailer`.
 *
 * `send` throws `MailDeliveryError` when the server cannot be reached or refuses the message, and
 * the caller (a BullMQ job) lets that fail the job so it is retried.
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/** The mail server could not be reached or refused the message; the message never reaches users. */
export class MailDeliveryError extends Error {
  constructor(to: string, cause: unknown) {
    super(`Could not send the message to ${to}`, { cause });
    this.name = 'MailDeliveryError';
  }
}
