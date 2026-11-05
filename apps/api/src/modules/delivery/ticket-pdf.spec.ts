import { inflateSync } from 'node:zlib';
import type { DeliveryBooking, DeliveryTicket } from './booking-delivery';
import { TicketFont, ticketFonts } from './ticket-fonts';
import { drawQr, QR_QUIET_MODULES, qrMatrix, renderTicketsPdf } from './ticket-pdf';

const BOOKING_ID = '01a3a1aa-7100-7679-b8b1-000000000001';
const SHOWTIME_ID = '01a3a1aa-7100-7679-b8b1-0000000000a1';
const TIME_ZONE = 'Asia/Ho_Chi_Minh';

const ticket = (n: number, label: string): DeliveryTicket => ({
  id: `01a3a1aa-7100-7679-b8b1-00000000000${n}`,
  code: `TICKETCODE0${n}`,
  seatId: `01a3a1aa-7100-7679-b8b1-0000000000c${n}`,
  seatLabel: label,
  seatType: 'STANDARD',
  status: 'ISSUED',
});

const booking = (tickets: DeliveryTicket[]): DeliveryBooking => ({
  id: BOOKING_ID,
  code: 'K7PX3MQ9TA',
  total: 180_000,
  emailSentAt: null,
  user: { id: 'u1', email: 'khach@test.local', fullName: 'Nguyễn Văn A' },
  // Diacritics everywhere: this is what a standard PDF font cannot draw.
  movie: { title: 'Mắt Biếc — Người Đẹp Và Thủy Quái' },
  showtime: {
    id: SHOWTIME_ID,
    startsAt: new Date('2026-11-05T12:30:00.000Z'),
    endsAt: new Date('2026-11-05T14:30:00.000Z'),
  },
  room: { name: 'Phòng chiếu số 2' },
  seats: [
    { seatId: 'c1', label: 'A1', type: 'STANDARD', price: 90_000 },
    { seatId: 'c2', label: 'A2', type: 'STANDARD', price: 90_000 },
  ],
  tickets,
});

const tokenOf = (code: string) => `${code}.signature-of-${code}`;

/** Number of `/Type /Page` objects, i.e. pages, in the raw PDF bytes. */
const pageCount = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

describe('renderTicketsPdf', () => {
  it('writes a PDF with one page per ticket', async () => {
    const pdf = await renderTicketsPdf({
      booking: booking([ticket(1, 'A1'), ticket(2, 'A2')]),
      timeZone: TIME_ZONE,
      tokenOf,
    });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
    expect(pageCount(pdf)).toBe(2);
    expect(pdf.length).toBeGreaterThan(10_000);
  });

  it('embeds the Unicode font instead of relying on a standard one', async () => {
    const pdf = await renderTicketsPdf({
      booking: booking([ticket(1, 'A1')]),
      timeZone: TIME_ZONE,
      tokenOf,
    });
    const raw = pdf.toString('latin1');

    // A subset of an embedded TrueType font, not Helvetica and friends.
    expect(raw).toContain('BeVietnamPro');
    expect(raw).toContain('/FontFile2');
    expect(raw).not.toContain('/BaseFont /Helvetica');
  });

  it('asks for a QR of every ticket code, and of nothing else', async () => {
    const asked: string[] = [];

    await renderTicketsPdf({
      booking: booking([ticket(1, 'A1'), ticket(2, 'A2')]),
      timeZone: TIME_ZONE,
      tokenOf: (code) => {
        asked.push(code);
        return tokenOf(code);
      },
    });

    expect(asked).toEqual(['TICKETCODE01', 'TICKETCODE02']);
  });

  it('puts no personal detail in the file, only what the ticket is for', async () => {
    const pdf = await renderTicketsPdf({
      booking: booking([ticket(1, 'A1')]),
      timeZone: TIME_ZONE,
      tokenOf,
    });
    const raw = pdf.toString('latin1');

    // Text is drawn with the subset font, so the e-mail cannot be read out of the bytes either;
    // what this checks is that it is not in the metadata or anywhere else in plain sight.
    expect(raw).not.toContain('khach@test.local');
    expect(raw).not.toContain('Nguyễn Văn A');
  });

  it('still produces a one-page PDF for a booking with no ticket', async () => {
    const pdf = await renderTicketsPdf({ booking: booking([]), timeZone: TIME_ZONE, tokenOf });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
  });

  it('is deterministic: the same booking renders to the same bytes', async () => {
    const input = {
      booking: booking([ticket(1, 'A1')]),
      timeZone: TIME_ZONE,
      tokenOf,
    };

    const [first, second] = await Promise.all([renderTicketsPdf(input), renderTicketsPdf(input)]);

    expect(first.equals(second)).toBe(true);
  });
});

describe('ticketFonts', () => {
  it('finds both font files and they are TrueType', () => {
    const fonts = ticketFonts();

    for (const font of Object.values(TicketFont)) {
      expect(fonts[font].length).toBeGreaterThan(50_000);
      // 0x00010000: the TrueType version tag.
      expect(fonts[font].subarray(0, 4).toString('hex')).toBe('00010000');
    }
  });

  it('reads the files once and caches them', () => {
    expect(ticketFonts()).toBe(ticketFonts());
  });
});

/**
 * The QR is drawn as rectangles, so a geometry bug would make an unreadable code that still looks
 * like a QR. This reconstructs the module matrix from the rectangles that were drawn and compares
 * it with what the `qrcode` library says the code is.
 */
describe('drawQr', () => {
  const TOKEN = 'TICKETCODE01.signature-of-TICKETCODE01';
  const BOX = 168;
  const AT = { x: 40, y: 200 };

  interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** A pdfkit stand-in that records the rectangles and ignores the rest. */
  function fakeDoc() {
    const rects: Rect[] = [];
    const doc = {
      rect: (x: number, y: number, width: number, height: number) => {
        rects.push({ x, y, width, height });
        return doc;
      },
      fill: () => doc,
      fillColor: () => doc,
      save: () => doc,
      restore: () => doc,
    };
    return { doc, rects };
  }

  it('draws every dark module, and only those, in the right place', () => {
    const qr = qrMatrix(TOKEN);
    const { doc, rects } = fakeDoc();

    drawQr(doc as unknown as Parameters<typeof drawQr>[0], qr, AT.x, AT.y, BOX);

    const module = BOX / (qr.size + QR_QUIET_MODULES * 2);
    // The first rectangle is the white background of the whole box.
    expect(rects[0]).toEqual({ x: AT.x, y: AT.y, width: BOX, height: BOX });
    const drawn = new Set<string>();
    for (const rect of rects.slice(1)) {
      const column = Math.round((rect.x - AT.x) / module) - QR_QUIET_MODULES;
      const row = Math.round((rect.y - AT.y) / module) - QR_QUIET_MODULES;
      const span = Math.round(rect.width / module);
      expect(rect.height).toBeCloseTo(module, 6);
      // Runs of dark modules are merged into one rectangle.
      for (let i = 0; i < span; i += 1) drawn.add(`${row},${column + i}`);
    }
    const expected = new Set<string>();
    for (let row = 0; row < qr.size; row += 1) {
      for (let column = 0; column < qr.size; column += 1) {
        if (qr.dark[row * qr.size + column]) expected.add(`${row},${column}`);
      }
    }

    expect([...drawn].sort()).toEqual([...expected].sort());
    // A sanity bound: a QR is roughly half dark, never empty or solid.
    expect(expected.size).toBeGreaterThan(qr.size * qr.size * 0.25);
    expect(expected.size).toBeLessThan(qr.size * qr.size * 0.75);
  });

  it('leaves the quiet zone the specification asks for', () => {
    const qr = qrMatrix(TOKEN);
    const { doc, rects } = fakeDoc();

    drawQr(doc as unknown as Parameters<typeof drawQr>[0], qr, AT.x, AT.y, BOX);

    const module = BOX / (qr.size + QR_QUIET_MODULES * 2);
    const quiet = QR_QUIET_MODULES * module;
    for (const rect of rects.slice(1)) {
      expect(rect.x).toBeGreaterThanOrEqual(AT.x + quiet - 1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(AT.y + quiet - 1e-6);
      expect(rect.x + rect.width).toBeLessThanOrEqual(AT.x + BOX - quiet + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(AT.y + BOX - quiet + 1e-6);
    }
  });

  it('a different token gives a different matrix', () => {
    expect(qrMatrix(TOKEN).dark).not.toEqual(qrMatrix(`${TOKEN}X`).dark);
  });
});

/**
 * A PDF drawn with a subset font keeps the text readable only if it also carries a `ToUnicode`
 * map. Without one the page looks right but copying, searching or extracting the text gives
 * nonsense — and Vietnamese is exactly where that shows.
 */
describe('Vietnamese text in the PDF', () => {
  /** Every FlateDecode stream of the file, inflated. */
  function inflatedStreams(pdf: Buffer): string[] {
    const raw = pdf.toString('latin1');
    const streams: string[] = [];
    for (const match of raw.matchAll(/stream\r?\n/g)) {
      const start = match.index + match[0].length;
      const end = raw.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        streams.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
      } catch {
        // Not a compressed stream (an image, a font file): nothing to read here.
      }
    }
    return streams;
  }

  it('maps every diacritic it draws back to its Unicode code point', async () => {
    const pdf = await renderTicketsPdf({
      booking: booking([ticket(1, 'A1')]),
      timeZone: TIME_ZONE,
      tokenOf,
    });

    const cmaps = inflatedStreams(pdf)
      .filter((stream) => stream.includes('beginbfchar') || stream.includes('beginbfrange'))
      .join('\n')
      .toLowerCase();
    expect(pdf.toString('latin1')).toContain('/ToUnicode');
    // ắ ế ờ ủ Đ đ — from the movie title, the room name and the footer note.
    for (const codePoint of ['1eaf', '1ebf', '1edd', '1ee7', '0110', '0111']) {
      expect(cmaps).toContain(`<${codePoint}>`);
    }
  });
});
