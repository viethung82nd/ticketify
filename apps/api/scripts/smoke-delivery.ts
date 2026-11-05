/**
 * End-to-end check of the phase 4 Definition of Done: pick seats → pay → get the email with the
 * ticket PDF (ROADMAP 4.9).
 *
 * Unlike the integration suites, this talks to a **running** stack over HTTP, so it also proves
 * the wiring: the worker process boots, its relay polls, Mailpit really receives a message and
 * RustFS really holds the file.
 *
 * Needs, from the repo root:
 *   docker compose up -d
 *   pnpm db:deploy && pnpm db:seed
 *   pnpm --filter @ticketify/api dev        (API, port 3000)
 *   pnpm --filter @ticketify/api dev:worker (worker)
 * then:
 *   pnpm --filter @ticketify/api smoke:delivery
 *
 * The payment is a signed IPN built with VNPAY_HASH_SECRET from .env, because paying a real card
 * on the VNPay sandbox is on hold (ROADMAP 3.6). Everything after the IPN is the real thing.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client';
import { VnpayService } from '../src/modules/payment/vnpay/vnpay.service';

loadEnv({ path: join(__dirname, '..', '..', '..', '.env'), quiet: true });

const API = process.env.SMOKE_API_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;
const MAILPIT = process.env.SMOKE_MAILPIT_URL ?? 'http://localhost:8025';
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? 'admin@ticketify.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'dev-admin-password';
const PASSWORD = 'Smoke-delivery-1';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wall clock in epoch milliseconds. A script driving a running stack has no `ClockService` to
 * inject, so the one place that needs "now" says so here instead of scattering `Date.now()`.
 */
const nowMs = (): number => performance.timeOrigin + performance.now();

async function eventually<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  for (let waited = 0; waited < timeoutMs; waited += 250) {
    const value = await read();
    if (value !== undefined) return value;
    await pause(250);
  }
  throw new Error(`${what}: not within ${timeoutMs} ms`);
}

interface Json {
  [key: string]: unknown;
}

async function call<T>(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const step = (message: string): void => console.info(`• ${message}`);

async function main(): Promise<void> {
  const hashSecret = required('VNPAY_HASH_SECRET');
  const tmnCode = required('VNPAY_TMN_CODE');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });

  try {
    const health = await call<Json>('/health');
    step(`API is up: ${JSON.stringify(health)}`);

    // ─── An admin sets up a showtime ───
    const admin = await call<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const adminToken = admin.accessToken;
    step(`signed in as ${ADMIN_EMAIL}`);

    // Showtimes lock their seat prices at creation, so the price table must exist.
    await prisma.seatPrice.createMany({
      data: (['STANDARD', 'VIP', 'COUPLE'] as const).flatMap((seatType) =>
        (['WEEKDAY', 'WEEKEND', 'HOLIDAY'] as const).map((dayType) => ({
          seatType,
          dayType,
          price: 90_000,
        })),
      ),
      skipDuplicates: true,
    });

    const suffix = randomUUID().slice(0, 8);
    const movie = await call<{ id: string; title: string }>('/admin/movies', {
      method: 'POST',
      token: adminToken,
      body: {
        title: `Mắt Biếc — Smoke ${suffix}`,
        duration: 100,
        ageRating: 'P',
        status: 'NOW_SHOWING',
        releaseDate: '2026-10-01',
        genreIds: [],
        posterKey: null,
      },
    });
    const room = await call<{ id: string; seats: { id: string; row: string; number: number }[] }>(
      '/admin/rooms',
      {
        method: 'POST',
        token: adminToken,
        body: { name: `Phòng Smoke ${suffix}`, rows: 1, cols: 4 },
      },
    );
    // Two hours from now: well clear of "already started", whatever the cinema's zone.
    const startsAt = new Date(nowMs() + 2 * 60 * 60 * 1000).toISOString();
    const showtime = await call<{ id: string }>('/admin/showtimes', {
      method: 'POST',
      token: adminToken,
      body: { movieId: movie.id, roomId: room.id, startsAt },
    });
    step(`showtime ${showtime.id} in room ${room.id} at ${startsAt}`);

    // ─── A customer picks seats ───
    const email = `smoke-${suffix}@ticketify.local`;
    const user = await call<{ accessToken: string; user: { id: string } }>('/auth/register', {
      method: 'POST',
      body: { email, password: PASSWORD, fullName: 'Nguyễn Thị Hồng Nhung' },
    });
    const seatIds = room.seats
      .sort((a, b) => a.row.localeCompare(b.row) || a.number - b.number)
      .slice(0, 2)
      .map((seat) => seat.id);
    const booking = await call<{ id: string; code: string; total: number }>('/bookings', {
      method: 'POST',
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { showtimeId: showtime.id, seatIds },
    });
    step(`booking ${booking.code} holds ${seatIds.length} seats, total ${booking.total}`);

    // ─── …and pays ───
    const payment = await call<{ paymentUrl: string }>('/payments/vnpay', {
      method: 'POST',
      token: user.accessToken,
      body: { bookingId: booking.id },
    });
    const txnRef = new URL(payment.paymentUrl).searchParams.get('vnp_TxnRef');
    if (!txnRef) throw new Error('No vnp_TxnRef in the payment URL');

    // The IPN VNPay would send, signed with the same secret the API verifies with.
    const vnpay = new VnpayService();
    const query = vnpay.buildSignedQuery(
      {
        vnp_Amount: String(booking.total * 100),
        vnp_BankCode: 'NCB',
        vnp_BankTranNo: `VNP${String(nowMs())}`,
        vnp_CardType: 'ATM',
        vnp_OrderInfo: `Thanh toan ve ${booking.code}`,
        vnp_PayDate: new Date(nowMs()).toISOString().replace(/[-:T]/g, '').slice(0, 14),
        vnp_ResponseCode: '00',
        vnp_TmnCode: tmnCode,
        vnp_TransactionNo: String(nowMs()).slice(-10),
        vnp_TransactionStatus: '00',
        vnp_TxnRef: txnRef,
      },
      hashSecret,
    );
    const ipn = await call<{ RspCode: string; Message: string }>(`/payments/vnpay/ipn?${query}`);
    if (ipn.RspCode !== '00') throw new Error(`IPN answered ${JSON.stringify(ipn)}`);
    step(`IPN accepted: ${JSON.stringify(ipn)}`);

    const confirmed = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { status: true, tickets: { select: { code: true } } },
    });
    if (confirmed.status !== 'CONFIRMED') throw new Error(`Booking is ${confirmed.status}`);
    step(`booking CONFIRMED with ${confirmed.tickets.length} ticket(s)`);

    // ─── The worker delivers ───
    interface MailSummary {
      ID: string;
      Subject: string;
      Attachments: number;
      To: { Address: string }[];
    }
    const message = await eventually('the email arrives in Mailpit', async () => {
      const res = await fetch(`${MAILPIT}/api/v1/messages?limit=200`);
      const body = (await res.json()) as { messages: MailSummary[] };
      return body.messages.find((item) => item.To.some((to) => to.Address === email));
    });
    step(`email to ${email}: "${message.Subject}" with ${message.Attachments} attachment(s)`);
    if (message.Attachments !== 1) throw new Error('Expected exactly one attachment');

    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
      Attachments: { PartID: string; FileName: string; ContentType: string }[];
    };
    const part = full.Attachments[0]!;
    const attached = Buffer.from(
      await (
        await fetch(`${MAILPIT}/api/v1/message/${message.ID}/part/${part.PartID}`)
      ).arrayBuffer(),
    );
    if (!attached.subarray(0, 5).toString().startsWith('%PDF-')) {
      throw new Error(`${part.FileName} is not a PDF`);
    }
    step(`attachment ${part.FileName} (${part.ContentType}, ${attached.length} bytes) is a PDF`);

    // ─── …and the customer can download the same file ───
    const link = await eventually('the ticket PDF link', async () => {
      try {
        return await call<{ url: string; expiresIn: number }>(
          `/bookings/${booking.id}/ticket-pdf`,
          { token: user.accessToken },
        );
      } catch {
        return undefined;
      }
    });
    const downloaded = Buffer.from(await (await fetch(link.url)).arrayBuffer());
    const pages = (downloaded.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    step(`downloaded ${downloaded.length} bytes, ${pages} page(s), link valid ${link.expiresIn}s`);
    if (!downloaded.equals(attached)) {
      throw new Error('The download and the attachment are not the same file');
    }
    if (pages !== confirmed.tickets.length) {
      throw new Error(`Expected one page per ticket, got ${pages}`);
    }

    const notifications = await prisma.notification.count({
      where: { data: { path: ['bookingId'], equals: booking.id } },
    });
    const emailSentAt = (
      await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        select: { emailSentAt: true },
      })
    ).emailSentAt;
    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: booking.id },
      select: { type: true, status: true },
    });
    step(
      `notifications ${notifications}, emailSentAt ${emailSentAt?.toISOString() ?? 'null'}, ` +
        `outbox ${JSON.stringify(outbox)}`,
    );

    console.info(
      `\n✔ phase 4 DoD: seats → payment → email with a ${pages}-page PDF, same bytes as the ` +
        `download. booking ${booking.code}, tickets ${confirmed.tickets
          .map((ticket) => ticket.code)
          .join(', ')}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
