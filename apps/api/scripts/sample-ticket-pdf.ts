/**
 * Writes a sample ticket PDF to `artifacts/tickets/sample.pdf` so a person can look at it:
 * Vietnamese diacritics, the layout, and whether a phone really scans the QR codes.
 *
 * `pnpm --filter @ticketify/api sample:ticket-pdf`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveryBooking } from '../src/modules/delivery/booking-delivery';
import { renderTicketsPdf } from '../src/modules/delivery/ticket-pdf';
import { ticketToken } from '../src/modules/tickets/ticket-token';

const SECRET = 'sample-only-ticket-qr-secret-0123456789';

const booking: DeliveryBooking = {
  id: '01a3a1aa-7100-7679-b8b1-000000000001',
  code: 'K7PX3MQ9TA',
  total: 270_000,
  emailSentAt: null,
  user: { id: 'u1', email: 'khach@test.local', fullName: 'Nguyễn Thị Hồng Nhung' },
  movie: { title: 'Mắt Biếc — Người Đẹp Và Thủy Quái' },
  showtime: {
    id: '01a3a1aa-7100-7679-b8b1-0000000000a1',
    startsAt: new Date('2026-11-05T12:30:00.000Z'),
    endsAt: new Date('2026-11-05T14:45:00.000Z'),
  },
  room: { name: 'Phòng chiếu số 2 (IMAX)' },
  seats: [],
  tickets: [
    {
      id: 't1',
      code: 'K7PXA1B2C3D4',
      seatId: 's1',
      seatLabel: 'A1',
      seatType: 'STANDARD',
      status: 'ISSUED',
    },
    {
      id: 't2',
      code: 'K7PXE5F6G7H8',
      seatId: 's2',
      seatLabel: 'A2',
      seatType: 'VIP',
      status: 'ISSUED',
    },
    {
      id: 't3',
      code: 'K7PXI9J0K1L2',
      seatId: 's3',
      seatLabel: 'B10',
      seatType: 'COUPLE',
      status: 'ISSUED',
    },
  ],
};

async function main(): Promise<void> {
  const pdf = await renderTicketsPdf({
    booking,
    timeZone: 'Asia/Ho_Chi_Minh',
    tokenOf: (code) => ticketToken(code, SECRET),
  });
  const directory = join(__dirname, '..', '..', '..', 'artifacts', 'tickets');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'sample.pdf');
  writeFileSync(file, pdf);
  console.info(`${pdf.length} bytes written to ${file} (${booking.tickets.length} pages)`);
}

void main();
