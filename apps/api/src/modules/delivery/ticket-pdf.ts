import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { DeliveryBooking, DeliveryTicket } from './booking-delivery';
import { cinemaMoment, money } from './delivery-text';
import { TicketFont, ticketFonts } from './ticket-fonts';

/**
 * The ticket PDF (ROADMAP 4.4): one A5 page per ticket, each with its own QR code.
 *
 * One page per ticket rather than one sheet with every seat on it, because tickets are torn
 * apart: two people arriving separately each need a page, and check-in is per ticket
 * (`tickets.code`), not per booking.
 *
 * Everything on the page comes from the database; the QR carries the signed token of that
 * ticket's code and nothing else — no name, no email, no user id — so a photographed ticket
 * reveals nothing about its owner.
 */

/** A5 portrait, in points: a ticket a phone can show and a printer can put on half a sheet. */
const PAGE = { width: 419.53, height: 595.28 } as const;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const QR_SIZE = 168;

const COLOR = {
  ink: '#111111',
  muted: '#666666',
  rule: '#dddddd',
} as const;

export interface TicketPdfInput {
  booking: DeliveryBooking;
  /** `CINEMA_TZ`: the times on a ticket are the ones printed on the cinema's wall. */
  timeZone: string;
  /** The signed QR token of one ticket code (`ticketToken`). */
  tokenOf: (ticketCode: string) => string;
}

/**
 * Renders the whole booking to one PDF. Resolves with the finished bytes; pdfkit streams, so the
 * buffer is collected here and the caller never sees a stream.
 *
 * A booking with no ticket (one under review) still gets a one-page document saying so, rather
 * than an empty file: an empty PDF is a corrupt PDF to most readers.
 */
export async function renderTicketsPdf(input: TicketPdfInput): Promise<Buffer> {
  const { booking, timeZone } = input;
  const qrCodes = booking.tickets.map((ticket) => qrMatrix(input.tokenOf(ticket.code)));

  const fonts = ticketFonts();
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margin: MARGIN,
    autoFirstPage: false,
    info: {
      Title: `Ticketify ${booking.code}`,
      Author: 'Ticketify',
      Subject: booking.movie.title,
      CreationDate: booking.showtime.startsAt,
    },
  });
  doc.registerFont(TicketFont.REGULAR, fonts[TicketFont.REGULAR]);
  doc.registerFont(TicketFont.SEMIBOLD, fonts[TicketFont.SEMIBOLD]);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  if (booking.tickets.length === 0) {
    drawNoTickets(doc, booking, timeZone);
  } else {
    booking.tickets.forEach((ticket, index) => {
      drawTicket(doc, {
        booking,
        ticket,
        timeZone,
        qr: qrCodes[index]!,
        position: { index: index + 1, total: booking.tickets.length },
      });
    });
  }

  doc.end();
  return done;
}

/** The dark/light modules of one token's QR code. */
export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number;
  /** `true` where the module is dark; row-major, `size × size`. */
  dark: boolean[];
}

/**
 * The QR of one token as its module matrix.
 *
 * Drawn as vector rectangles rather than placed as a PNG: a QR is black squares on white, so
 * rectangles are exact at any print size (a raster has to guess), the file stays a few kilobytes,
 * and there is no PNG encoding — which took seconds per code at print resolution.
 */
export function qrMatrix(token: string): QrMatrix {
  const { modules } = QRCode.create(token, { errorCorrectionLevel: 'M' });
  return { size: modules.size, dark: Array.from(modules.data, (bit) => bit === 1) };
}

/** Quiet zone the QR specification asks for, in modules, on every side. */
export const QR_QUIET_MODULES = 4;

/**
 * Draws one QR in a `size × size` box at `(x, y)`, white background and quiet zone included.
 * Runs of dark modules in a row become one rectangle, which keeps the page a few hundred
 * operations instead of a few thousand.
 */
export function drawQr(doc: Doc, qr: QrMatrix, x: number, y: number, size: number): void {
  const modules = qr.size + QR_QUIET_MODULES * 2;
  const module = size / modules;
  doc.save();
  doc.rect(x, y, size, size).fill('#ffffff');
  doc.fillColor(COLOR.ink);
  for (let row = 0; row < qr.size; row += 1) {
    let runStart = -1;
    for (let column = 0; column <= qr.size; column += 1) {
      const dark = column < qr.size && qr.dark[row * qr.size + column] === true;
      if (dark && runStart < 0) runStart = column;
      if (!dark && runStart >= 0) {
        doc.rect(
          x + (runStart + QR_QUIET_MODULES) * module,
          y + (row + QR_QUIET_MODULES) * module,
          (column - runStart) * module,
          module,
        );
        runStart = -1;
      }
    }
  }
  doc.fill();
  doc.restore();
}

type Doc = PDFKit.PDFDocument;

interface TicketPage {
  booking: DeliveryBooking;
  ticket: DeliveryTicket;
  timeZone: string;
  qr: QrMatrix;
  position: { index: number; total: number };
}

function drawTicket(doc: Doc, page: TicketPage): void {
  const { booking, ticket, timeZone, position } = page;
  doc.addPage();

  header(doc, `Vé ${position.index}/${position.total}`);

  doc
    .font(TicketFont.SEMIBOLD)
    .fontSize(20)
    .fillColor(COLOR.ink)
    .text(booking.movie.title, { width: CONTENT_WIDTH });
  doc.moveDown(0.8);

  const startedAt = cinemaMoment(booking.showtime.startsAt, timeZone);
  rows(doc, [
    ['Suất chiếu', startedAt],
    ['Phòng', booking.room.name],
    ['Ghế', `${ticket.seatLabel} (${seatTypeText(ticket.seatType)})`],
    ['Mã đơn', booking.code],
    ['Mã vé', ticket.code],
  ]);

  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.8);

  // The QR, centred, with the code under it so a broken scanner is never a dead end.
  const qrX = MARGIN + (CONTENT_WIDTH - QR_SIZE) / 2;
  const qrY = doc.y;
  drawQr(doc, page.qr, qrX, qrY, QR_SIZE);
  doc.y = qrY + QR_SIZE + 8;
  doc
    .font(TicketFont.REGULAR)
    .fontSize(9)
    .fillColor(COLOR.muted)
    .text('Quét mã này tại cửa vào', { width: CONTENT_WIDTH, align: 'center' });

  footer(
    doc,
    'Vui lòng đến trước giờ chiếu 15 phút. Mỗi mã vé chỉ dùng được một lần. ' +
      'Vé đã mua không đổi hoặc hoàn tiền.',
  );
}

/** A booking under review has no ticket; the file still has to be a readable PDF. */
function drawNoTickets(doc: Doc, booking: DeliveryBooking, timeZone: string): void {
  doc.addPage();
  header(doc, 'Chưa có vé');
  doc
    .font(TicketFont.SEMIBOLD)
    .fontSize(20)
    .fillColor(COLOR.ink)
    .text(booking.movie.title, { width: CONTENT_WIDTH });
  doc.moveDown(0.8);
  rows(doc, [
    ['Suất chiếu', cinemaMoment(booking.showtime.startsAt, timeZone)],
    ['Phòng', booking.room.name],
    ['Mã đơn', booking.code],
    ['Số tiền', money(booking.total)],
  ]);
  doc.moveDown(0.8);
  doc
    .font(TicketFont.REGULAR)
    .fontSize(11)
    .fillColor(COLOR.ink)
    .text(
      'Đơn này đang được nhân viên xem lại, nên chưa có vé nào được phát hành. ' +
        'Chúng tôi sẽ liên hệ với bạn.',
      { width: CONTENT_WIDTH },
    );
  footer(doc, 'Cần hỗ trợ? Vui lòng liên hệ quầy vé của rạp.');
}

function header(doc: Doc, badge: string): void {
  doc.font(TicketFont.SEMIBOLD).fontSize(13).fillColor(COLOR.ink).text('TICKETIFY', MARGIN, MARGIN);
  doc
    .font(TicketFont.REGULAR)
    .fontSize(10)
    .fillColor(COLOR.muted)
    .text(badge, MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'right' });
  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.8);
}

function footer(doc: Doc, note: string): void {
  const y = PAGE.height - MARGIN - 34;
  doc
    .font(TicketFont.REGULAR)
    .fontSize(8)
    .fillColor(COLOR.muted)
    .text(note, MARGIN, y, { width: CONTENT_WIDTH, align: 'center' });
}

/** Label/value lines, the label in grey on the left and the value in bold on the right. */
function rows(doc: Doc, lines: readonly [string, string][]): void {
  const labelWidth = 92;
  for (const [label, value] of lines) {
    const y = doc.y;
    doc
      .font(TicketFont.REGULAR)
      .fontSize(10)
      .fillColor(COLOR.muted)
      .text(label, MARGIN, y + 2, { width: labelWidth });
    doc
      .font(TicketFont.SEMIBOLD)
      .fontSize(12)
      .fillColor(COLOR.ink)
      .text(value, MARGIN + labelWidth, y, { width: CONTENT_WIDTH - labelWidth });
    doc.moveDown(0.35);
  }
}

function rule(doc: Doc): void {
  const y = doc.y;
  doc
    .moveTo(MARGIN, y)
    .lineTo(PAGE.width - MARGIN, y)
    .lineWidth(0.5)
    .strokeColor(COLOR.rule)
    .stroke();
  doc.y = y;
}

const SEAT_TYPE_TEXT: Readonly<Record<string, string>> = {
  STANDARD: 'Thường',
  VIP: 'VIP',
  COUPLE: 'Đôi',
};

const seatTypeText = (type: string): string => SEAT_TYPE_TEXT[type] ?? type;
