import { MailDeliveryError, Mailer, type MailMessage } from '../mailer';

/**
 * In-memory `Mailer` for tests: records the messages, and `down = true` makes every send fail the
 * way an unreachable SMTP server does.
 */
export class FakeMailer extends Mailer {
  readonly sent: MailMessage[] = [];
  down = false;

  send(message: MailMessage): Promise<void> {
    if (this.down) {
      return Promise.reject(new MailDeliveryError(message.to, new Error('SMTP down')));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
  }

  /** The messages sent to one address, oldest first. */
  to(address: string): MailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }
}
