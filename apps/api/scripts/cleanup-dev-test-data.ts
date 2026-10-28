/**
 * Deletes rooms whose name starts with a prefix, and everything attached to them, from the
 * LOCAL development database: their seats, showtimes, showtime seats, and the bookings of those
 * showtimes (with their seat and combo lines). Nothing else is touched: movies, users, combos and
 * prices stay. Leftovers of manual end-to-end runs (week 8: rooms "Phòng W8 Expiry <n>").
 *
 *   pnpm --filter @ticketify/api db:cleanup-test-data                  # dry run, default prefix
 *   pnpm --filter @ticketify/api db:cleanup-test-data -- --apply
 *   pnpm --filter @ticketify/api db:cleanup-test-data -- --prefix "Phòng PW" --apply
 *
 * Refuses to run against a non-local database, and stops (deleting nothing) if a booking it would
 * delete has a payment or a ticket: those are never test leftovers to throw away silently.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client';

loadEnv({ path: ['.env', '../../.env'], quiet: true });

const DEFAULT_PREFIX = 'Phòng W8 Expiry';
/** A shorter prefix could match real rooms ("Phòng" alone matches every room). */
const MIN_PREFIX_LENGTH = 8;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

interface Options {
  prefix: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { prefix: DEFAULT_PREFIX, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--prefix') options.prefix = argv[++i] ?? '';
    else if (arg !== '--') throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.prefix.trim().length < MIN_PREFIX_LENGTH) {
    throw new Error(`--prefix must have at least ${MIN_PREFIX_LENGTH} characters`);
  }
  return options;
}

/** `LIKE` pattern matching names that start with `prefix` literally (`%`, `_`, `\` escaped). */
const startsWith = (prefix: string): string => `${prefix.replace(/[\\%_]/g, '\\$&')}%`;

class HasPaymentsOrTickets extends Error {}

async function main(): Promise<void> {
  const { prefix, apply } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing to clean a non-local database (${host})`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const deleted = await prisma.$transaction(
      async (tx) => {
        const rooms = await tx.$queryRaw<{ id: string; name: string }[]>`
          SELECT id, name FROM rooms WHERE name LIKE ${startsWith(prefix)} ORDER BY name
          FOR UPDATE`;
        const roomIds = rooms.map((room) => room.id);
        const showtimeIds = (
          await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM showtimes WHERE room_id = ANY(${roomIds}::uuid[])`
        ).map((row) => row.id);
        const bookingIds = (
          await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM bookings WHERE showtime_id = ANY(${showtimeIds}::uuid[])`
        ).map((row) => row.id);

        const [payments, tickets] = await Promise.all([
          tx.payment.count({ where: { bookingId: { in: bookingIds } } }),
          tx.ticket.count({ where: { bookingId: { in: bookingIds } } }),
        ]);
        if (payments + tickets > 0) {
          throw new HasPaymentsOrTickets(
            `${payments} payment(s) and ${tickets} ticket(s) belong to these bookings; ` +
              'nothing deleted. Remove them by hand if they really are test data.',
          );
        }

        console.info(`Prefix "${prefix}": ${rooms.length} room(s)`);
        for (const room of rooms) console.info(`  - ${room.name} (${room.id})`);

        // Children first: booking lines reference showtime seats, showtime seats reference
        // bookings (RESTRICT) and seats, showtimes reference rooms.
        const counts = {
          bookingCombos: await tx.bookingCombo.deleteMany({
            where: { bookingId: { in: bookingIds } },
          }),
          bookingSeats: await tx.bookingSeat.deleteMany({
            where: { bookingId: { in: bookingIds } },
          }),
          showtimeSeats: await tx.showtimeSeat.deleteMany({
            where: { showtimeId: { in: showtimeIds } },
          }),
          bookings: await tx.booking.deleteMany({ where: { id: { in: bookingIds } } }),
          showtimes: await tx.showtime.deleteMany({ where: { id: { in: showtimeIds } } }),
          seats: await tx.seat.deleteMany({ where: { roomId: { in: roomIds } } }),
          rooms: await tx.room.deleteMany({ where: { id: { in: roomIds } } }),
        };
        const result = Object.fromEntries(
          Object.entries(counts).map(([table, { count }]) => [table, count]),
        );
        // A dry run does the same work and rolls it back, so its counts are exact.
        if (!apply) throw new DryRun(result);
        return result;
      },
      { timeout: 30_000 },
    );
    console.info('Deleted:', deleted);
  } catch (error) {
    if (error instanceof DryRun) {
      console.info('Dry run (nothing deleted; add --apply). Would delete:', error.counts);
      return;
    }
    if (error instanceof HasPaymentsOrTickets) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

class DryRun extends Error {
  constructor(readonly counts: Record<string, number>) {
    super('dry run');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
