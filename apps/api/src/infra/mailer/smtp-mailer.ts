import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppConfig } from '../../config/app-config.service';
import { MailDeliveryError, Mailer, type MailMessage } from './mailer';

/** Fail fast instead of holding a job while the mail server is unreachable. */
const CONNECTION_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 10_000;

/**
 * `Mailer` over Nodemailer (SMTP). Mailpit locally, any SMTP server in production.
 *
 * One pooled transport for the process: a worker sends a handful of messages a minute, and
 * opening a connection per message is the slow part. No credentials and no TLS here on purpose —
 * Mailpit wants neither, and a deployment that does gets them from SMTP_HOST/PORT plus whatever
 * the host provides (see README); adding them is an env change, not a code change.
 */
@Injectable()
export class SmtpMailer extends Mailer implements OnApplicationShutdown {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: AppConfig) {
    super();
    this.from = config.get('SMTP_FROM');
    this.transport = createTransport({
      host: config.get('SMTP_HOST'),
      port: config.get('SMTP_PORT'),
      // Mailpit and most relays on 1025/25 speak plain SMTP; STARTTLS is used when offered.
      secure: false,
      ignoreTLS: false,
      pool: true,
      maxConnections: 2,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
    });
  }

  async send(message: MailMessage): Promise<void> {
    try {
      const sent = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments,
      });
      this.logger.debug(`Mail to ${message.to}: ${String(sent.messageId)}`);
    } catch (error) {
      throw new MailDeliveryError(message.to, error);
    }
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
