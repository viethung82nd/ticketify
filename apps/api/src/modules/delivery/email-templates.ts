import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { findAssetDir } from '../../common/assets';
import type { BookingNeedsReviewPayload } from '../../infra/outbox/outbox-payloads';
import type { DeliveryBooking } from './booking-delivery';
import { cinemaMoment, money, reviewReasonText } from './delivery-text';

/**
 * The two emails the cinema sends (ROADMAP 4.6): the tickets of a confirmed booking, and the
 * apology for one that went to review.
 *
 * Handlebars templates in `apps/api/assets/email`, compiled once per process. The templates hold
 * no logic beyond `{{value}}`: dates, money and the reason are already words by the time they get
 * here (`delivery-text.ts`), so the same wording is used by the notification and the email and
 * can be tested without rendering HTML.
 *
 * A plain-text alternative is written by hand rather than stripped from the HTML: a mail client
 * that shows the text part deserves something readable, not a de-tagged table.
 */

export const EmailTemplate = {
  CONFIRMED: 'confirmed',
  NEEDS_REVIEW: 'needs_review',
} as const;
export type EmailTemplate = (typeof EmailTemplate)[keyof typeof EmailTemplate];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const TEMPLATE_DIR = 'email';

type Template = Handlebars.TemplateDelegate<Record<string, unknown>>;

interface Compiled {
  layout: Template;
  bodies: Record<EmailTemplate, Template>;
}

let compiled: Compiled | undefined;

function templates(): Compiled {
  if (compiled) return compiled;
  const directory = findAssetDir(TEMPLATE_DIR, 'layout.hbs');
  const read = (name: string): Template =>
    Handlebars.compile<Record<string, unknown>>(
      readFileSync(join(directory, `${name}.hbs`), 'utf8'),
      { strict: false, noEscape: false },
    );
  compiled = {
    layout: read('layout'),
    bodies: {
      [EmailTemplate.CONFIRMED]: read(EmailTemplate.CONFIRMED),
      [EmailTemplate.NEEDS_REVIEW]: read(EmailTemplate.NEEDS_REVIEW),
    },
  };
  return compiled;
}

/** The booking fields both templates show, already turned into words. */
interface BookingView {
  booking: { code: string };
  user: { fullName: string };
  movie: { title: string };
  showtime: { startsAt: string };
  room: { name: string };
  bookingUrl: string;
}

const viewOf = (booking: DeliveryBooking, timeZone: string, webBaseUrl: string): BookingView => ({
  booking: { code: booking.code },
  user: { fullName: booking.user.fullName },
  movie: { title: booking.movie.title },
  showtime: { startsAt: cinemaMoment(booking.showtime.startsAt, timeZone) },
  room: { name: booking.room.name },
  bookingUrl: `${webBaseUrl.replace(/\/$/, '')}/bookings/${booking.id}`,
});

/** Wraps a rendered body in the shared layout. `body` is trusted HTML from our own template. */
const page = (subject: string, body: string): string =>
  templates().layout({ subject, body: new Handlebars.SafeString(body) });

export interface EmailContext {
  booking: DeliveryBooking;
  timeZone: string;
  /** Origin of the web app, for the "see my booking" link. */
  webBaseUrl: string;
}

/** The tickets of a confirmed booking. The PDF itself is attached by the caller. */
export function confirmedEmail(context: EmailContext): RenderedEmail {
  const { booking, timeZone, webBaseUrl } = context;
  const view = viewOf(booking, timeZone, webBaseUrl);
  const seats = booking.seats.map((seat) => seat.label).join(', ');
  const subject = `Vé của bạn — ${booking.movie.title} (đơn ${booking.code})`;
  const html = page(
    subject,
    templates().bodies[EmailTemplate.CONFIRMED]({
      ...view,
      seats,
      total: money(booking.total),
    }),
  );
  const text = [
    `Đơn ${booking.code} đã được xác nhận.`,
    '',
    `Phim: ${booking.movie.title}`,
    `Suất chiếu: ${view.showtime.startsAt}`,
    `Phòng: ${booking.room.name}`,
    `Ghế: ${seats}`,
    `Tổng tiền: ${money(booking.total)}`,
    '',
    'Vé của bạn được đính kèm trong email này dưới dạng PDF, mỗi vé một trang kèm mã QR.',
    `Xem đơn: ${view.bookingUrl}`,
    '',
    'Vui lòng đến trước giờ chiếu 15 phút. Mỗi mã vé chỉ dùng được một lần.',
  ].join('\n');
  return { subject, html, text };
}

/** The apology for a paid booking that could not keep its seats. No attachment. */
export function needsReviewEmail(
  context: EmailContext & { payload: BookingNeedsReviewPayload },
): RenderedEmail {
  const { booking, timeZone, webBaseUrl, payload } = context;
  const view = viewOf(booking, timeZone, webBaseUrl);
  const amount = money(payload.amount);
  const reason = reviewReasonText(payload.reason);
  const subject = `Đơn ${booking.code} cần được xem lại — chúng tôi sẽ hoàn tiền`;
  const html = page(
    subject,
    templates().bodies[EmailTemplate.NEEDS_REVIEW]({ ...view, amount, reasonText: reason }),
  );
  const text = [
    `Đơn ${booking.code} cần được xem lại.`,
    '',
    `Chúng tôi đã nhận ${amount}, nhưng ${reason}, nên chưa thể phát hành vé.`,
    '',
    `Phim: ${booking.movie.title}`,
    `Suất chiếu: ${view.showtime.startsAt}`,
    `Phòng: ${booking.room.name}`,
    `Số tiền đã nhận: ${amount}`,
    '',
    'Nhân viên của rạp sẽ liên hệ với bạn và hoàn lại toàn bộ số tiền này.',
    `Xem đơn: ${view.bookingUrl}`,
  ].join('\n');
  return { subject, html, text };
}
