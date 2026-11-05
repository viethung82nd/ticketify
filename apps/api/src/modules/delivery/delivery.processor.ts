import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import type { z } from 'zod';
import { AppConfig } from '../../config/app-config.service';
import { ClockService } from '../../infra/clock/clock.service';
import { type MailAttachment, Mailer } from '../../infra/mailer/mailer';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OutboxEventType } from '../../infra/outbox/outbox-events';
import {
  bookingConfirmedPayloadSchema,
  bookingNeedsReviewPayloadSchema,
  paymentRefundRequiredPayloadSchema,
  seatsReleasedPayloadSchema,
} from '../../infra/outbox/outbox-payloads';
import {
  DELIVERY_QUEUE,
  DeliveryAction,
  type DeliveryJobData,
} from '../../infra/queue/delivery-queue';
import { DeliveryQueueProducer } from '../../infra/queue/delivery-queue.producer';
import { QueueWorkers } from '../../infra/queue/queue-workers';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationEvents } from '../realtime/notification-events';
import { SeatEvents } from '../realtime/seat-events';
import { TicketPdfStorage } from '../tickets/ticket-pdf.storage';
import { ticketToken } from '../tickets/ticket-token';
import { BookingDelivery, BookingGoneError, type DeliveryBooking } from './booking-delivery';
import { confirmedEmail, needsReviewEmail } from './email-templates';
import {
  confirmedText,
  needsReviewAdminText,
  needsReviewUserText,
  type NotificationText,
  refundRequiredAdminText,
} from './delivery-text';
import { renderTicketsPdf } from './ticket-pdf';

/** Delivery jobs one worker process runs at the same time. */
export const DELIVERY_WORKER_CONCURRENCY = 5;

const PDF_TYPE = 'application/pdf';

/**
 * Worker side of the `delivery` queue (PLAN §7): every step that happens after a payment
 * transaction committed. Fed by the outbox relay, so each step must be idempotent — it may run
 * again after a crash or a lost acknowledgement.
 *
 * Steps: `broadcast-seats` (4.1), `notify` (4.2), `generate-pdf` (4.4–4.5) and `send-email`
 * (4.6). `generate-pdf` enqueues `send-email` itself once the file is in storage, because the
 * confirmation email attaches it; the apology of a booking under review needs no file, so the
 * relay enqueues that one straight away.
 */
@Injectable()
export class DeliveryProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeliveryProcessor.name);

  constructor(
    private readonly workers: QueueWorkers,
    private readonly seatEvents: SeatEvents,
    private readonly notifications: NotificationsService,
    private readonly notificationEvents: NotificationEvents,
    private readonly bookings: BookingDelivery,
    private readonly pdfs: TicketPdfStorage,
    private readonly mailer: Mailer,
    private readonly prisma: PrismaService,
    private readonly producer: DeliveryQueueProducer,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.workers.start<DeliveryJobData, void>(DELIVERY_QUEUE, (job) => this.process(job), {
      concurrency: DELIVERY_WORKER_CONCURRENCY,
    });
  }

  async process(job: Job<DeliveryJobData>): Promise<void> {
    switch (job.name) {
      case DeliveryAction.BROADCAST_SEATS:
        return this.broadcastSeats(job.data);
      case DeliveryAction.NOTIFY:
        return this.notify(job.data);
      case DeliveryAction.GENERATE_PDF:
        return this.generatePdf(job.data);
      case DeliveryAction.SEND_EMAIL:
        return this.sendEmail(job.data);
      default:
        // Nothing retries an unknown action: this build cannot grow a handler mid-job.
        throw new UnrecoverableError(`Unknown delivery action ${job.name}`);
    }
  }

  /**
   * `seats.released` → `seat:released` in room `showtime:{id}` (best-effort, never throws).
   *
   * The flow that released the seats also sends the event itself, right after its own commit, so
   * a browser sees the seats free within milliseconds; this one is the durable copy, which
   * arrives even if that process died first. A client may therefore get `seat:released` twice for
   * the same seats — applying it twice is the same as applying it once (ROADMAP "Đã chốt").
   */
  private broadcastSeats(data: DeliveryJobData): Promise<void> {
    const payload = this.parse(seatsReleasedPayloadSchema, data);
    this.seatEvents.released(payload.showtimeId, payload.seatIds);
    return Promise.resolve();
  }

  /**
   * Stores the notifications of one event and pushes the ones it really created (ROADMAP 4.2).
   *
   * Who hears about what: a confirmed booking goes to the user alone; a booking under review goes
   * to the user (an apology) and to every admin (something to fix); a double payment goes to the
   * admins alone, because the user owes nothing and would only be alarmed.
   */
  private async notify(data: DeliveryJobData): Promise<void> {
    const timeZone = this.config.get('CINEMA_TZ');
    switch (data.type) {
      case OutboxEventType.BOOKING_CONFIRMED: {
        const payload = this.parse(bookingConfirmedPayloadSchema, data);
        const booking = await this.booking(payload.bookingId, data);
        if (!booking) return;
        await this.push(data, [payload.userId], confirmedText(booking, timeZone));
        return;
      }
      case OutboxEventType.BOOKING_NEEDS_REVIEW: {
        const payload = this.parse(bookingNeedsReviewPayloadSchema, data);
        const booking = await this.booking(payload.bookingId, data);
        if (!booking) return;
        // The user first: an admin who booked for themselves gets the user's wording, because
        // the unique index allows one notification per user per event.
        await this.push(data, [payload.userId], needsReviewUserText(booking, payload, timeZone));
        await this.push(
          data,
          await this.notifications.adminIds(),
          needsReviewAdminText(booking, payload, timeZone),
        );
        return;
      }
      case OutboxEventType.PAYMENT_REFUND_REQUIRED: {
        const payload = this.parse(paymentRefundRequiredPayloadSchema, data);
        await this.push(
          data,
          await this.notifications.adminIds(),
          refundRequiredAdminText(payload),
        );
        return;
      }
      default:
        throw new UnrecoverableError(`No notification for outbox event type ${data.type}`);
    }
  }

  /**
   * `booking.confirmed` → the ticket PDF, written to `tickets/{bookingId}.pdf` (ROADMAP 4.4–4.5).
   *
   * Safe to run again: the key is fixed and the drawing is deterministic, so a second run
   * overwrites the file with the same bytes. Nothing reads the old file in between — an S3 PUT
   * replaces an object atomically.
   */
  private async generatePdf(data: DeliveryJobData): Promise<void> {
    const payload = this.parse(bookingConfirmedPayloadSchema, data);
    const booking = await this.booking(payload.bookingId, data);
    if (!booking) return;
    const secret = this.config.get('TICKET_QR_SECRET');
    const pdf = await renderTicketsPdf({
      booking,
      timeZone: this.config.get('CINEMA_TZ'),
      tokenOf: (code) => ticketToken(code, secret),
    });
    const key = await this.pdfs.save(booking.id, pdf);
    this.logger.log(
      `Booking ${booking.code}: ${booking.tickets.length} ticket(s), ${pdf.length} bytes at ${key}`,
    );
    // Only now, with the file really in storage, is there something to attach to the email.
    await this.producer.enqueue(data, [DeliveryAction.SEND_EMAIL]);
  }

  /**
   * The email about one booking's outcome: the tickets, or the apology (ROADMAP 4.6).
   *
   * `bookings.email_sent_at` is both the guard and the record: a booking that has it is skipped,
   * and it is written right after SMTP accepted the message. Delivery is therefore
   * **at-least-once** — a crash between those two points sends a second copy. That is the
   * accepted trade-off (PLAN §7): writing it first would risk a paying customer never getting
   * their tickets, and a duplicate email is an annoyance, not a loss.
   */
  private async sendEmail(data: DeliveryJobData): Promise<void> {
    const confirmation = data.type === OutboxEventType.BOOKING_CONFIRMED;
    if (!confirmation && data.type !== OutboxEventType.BOOKING_NEEDS_REVIEW) {
      throw new UnrecoverableError(`No email for outbox event type ${data.type}`);
    }
    const review = confirmation ? undefined : this.parse(bookingNeedsReviewPayloadSchema, data);
    const bookingId = confirmation
      ? this.parse(bookingConfirmedPayloadSchema, data).bookingId
      : review!.bookingId;

    const booking = await this.booking(bookingId, data);
    if (!booking) return;
    if (booking.emailSentAt) {
      this.logger.debug(
        `Booking ${booking.code}: email already sent at ${booking.emailSentAt.toISOString()}`,
      );
      return;
    }

    const context = {
      booking,
      timeZone: this.config.get('CINEMA_TZ'),
      webBaseUrl: this.webBaseUrl(),
    };
    const email = confirmation
      ? confirmedEmail(context)
      : needsReviewEmail({ ...context, payload: review! });
    const attachments = confirmation ? await this.ticketAttachment(booking) : [];

    await this.mailer.send({
      to: booking.user.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    // Written only after SMTP accepted the message, never before (see the note above).
    const marked = await this.prisma.booking.updateMany({
      where: { id: booking.id, emailSentAt: null },
      data: { emailSentAt: this.clock.now() },
    });
    this.logger.log(
      `Booking ${booking.code}: email sent to ${booking.user.email}` +
        (attachments.length > 0 ? ' with the ticket PDF' : '') +
        (marked.count === 0 ? ' (another run marked it first)' : ''),
    );
  }

  /**
   * The stored PDF as one attachment, or none of it.
   *
   * A confirmed booking whose file is missing (storage wiped, an old booking) still gets its
   * email: the booking page can produce the tickets again, and withholding the message would be
   * worse than sending it without the attachment.
   */
  private async ticketAttachment(booking: DeliveryBooking): Promise<MailAttachment[]> {
    const pdf = await this.pdfs.read(booking.id);
    if (!pdf) {
      this.logger.warn(
        `Booking ${booking.code}: no ticket PDF in storage; sending the email without it`,
      );
      return [];
    }
    return [{ filename: `ticketify-${booking.code}.pdf`, content: pdf, contentType: PDF_TYPE }];
  }

  /**
   * Origin of the web app, for the link in an email: the first `CORS_ORIGINS` entry, which is by
   * definition where the browsers that use this API come from.
   */
  private webBaseUrl(): string {
    return this.config.get('CORS_ORIGINS')[0] ?? '';
  }

  /** Stores one notification for each user, then pushes exactly the rows that were created. */
  private async push(
    data: DeliveryJobData,
    userIds: readonly string[],
    text: NotificationText,
  ): Promise<void> {
    const stored = await this.notifications.store({ ...text, userIds, eventId: data.eventId });
    for (const { userId, ...notification } of stored) {
      this.notificationEvents.created(userId, notification);
    }
    if (stored.length < userIds.length) {
      this.logger.debug(
        `Event ${data.eventId}: ${userIds.length - stored.length} notification(s) already stored`,
      );
    }
  }

  /**
   * The booking of an event, or `undefined` when it is gone — a booking deleted after the event
   * was written (test data, an admin cleanup) must not make a job retry forever.
   */
  private async booking(bookingId: string, data: DeliveryJobData) {
    try {
      return await this.bookings.read(bookingId);
    } catch (error) {
      if (!(error instanceof BookingGoneError)) throw error;
      this.logger.warn(`Event ${data.eventId} (${data.type}) dropped: ${error.message}`);
      return undefined;
    }
  }

  /** Parses a payload, or gives up on the job for good (a bad row is not a transient failure). */
  private parse<T extends z.ZodType>(schema: T, data: DeliveryJobData): z.infer<T> {
    const result = schema.safeParse(data.payload);
    if (!result.success) {
      const reason = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      this.logger.error(
        `Outbox event ${data.eventId} (${data.type}) has an unusable payload: ${reason}`,
      );
      throw new UnrecoverableError(`Outbox event ${data.eventId} has an unusable payload`);
    }
    return result.data;
  }
}
