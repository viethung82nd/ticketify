import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectViolation, SQLSTATE } from '../../support/db-errors';
import { createFixtures, type Fixtures } from '../../support/fixtures';

/**
 * Proves every hand-written constraint (prisma/migrations/*_db_constraints) blocks what it
 * must and still lets valid data through. See prisma/README.md.
 */
describe('database constraints (raw SQL migration)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await createTestDatabase();
    prisma = db.prisma;
    fx = createFixtures(prisma);
  });

  afterAll(async () => {
    await db.drop();
  });

  /** A showtime with seats and a booking that can own them. */
  async function seatContext() {
    const [user, movie, room] = await Promise.all([fx.user(), fx.movie(), fx.room()]);
    const seats = await Promise.all([1, 2, 3, 4].map((n) => fx.seat(room.id, n)));
    const showtime = await fx.showtime({
      movieId: movie.id,
      roomId: room.id,
      startsAt: '2026-11-01T10:00:00Z',
      endsAt: '2026-11-01T12:00:00Z',
    });
    const booking = await fx.booking(user.id, showtime.id);
    return { user, showtime, booking, seats };
  }

  describe('showtimes_no_overlap (exclusion constraint)', () => {
    const NO_OVERLAP = {
      sqlState: SQLSTATE.exclusionViolation,
      constraint: 'showtimes_no_overlap',
    };

    async function roomWithShowtime(status?: 'CANCELLED') {
      const [movie, room] = await Promise.all([fx.movie(), fx.room()]);
      const existing = await fx.showtime({
        movieId: movie.id,
        roomId: room.id,
        startsAt: '2026-11-01T10:00:00Z',
        endsAt: '2026-11-01T12:00:00Z',
        status,
      });
      return { movie, room, existing };
    }

    it('rejects an overlapping showtime in the same room', async () => {
      const { movie, room } = await roomWithShowtime();

      await expectViolation(
        fx.showtime({
          movieId: movie.id,
          roomId: room.id,
          startsAt: '2026-11-01T11:59:00Z',
          endsAt: '2026-11-01T14:00:00Z',
        }),
        NO_OVERLAP,
      );
    });

    it('rejects a showtime fully contained in another one', async () => {
      const { movie, room } = await roomWithShowtime();

      await expectViolation(
        fx.showtime({
          movieId: movie.id,
          roomId: room.id,
          startsAt: '2026-11-01T10:30:00Z',
          endsAt: '2026-11-01T11:00:00Z',
        }),
        NO_OVERLAP,
      );
    });

    it('allows the same time slot in a different room', async () => {
      const { movie } = await roomWithShowtime();
      const otherRoom = await fx.room();

      await expect(
        fx.showtime({
          movieId: movie.id,
          roomId: otherRoom.id,
          startsAt: '2026-11-01T10:00:00Z',
          endsAt: '2026-11-01T12:00:00Z',
        }),
      ).resolves.toBeDefined();
    });

    it('allows back-to-back showtimes (half-open range)', async () => {
      const { movie, room } = await roomWithShowtime();

      await expect(
        fx.showtime({
          movieId: movie.id,
          roomId: room.id,
          startsAt: '2026-11-01T12:00:00Z',
          endsAt: '2026-11-01T14:00:00Z',
        }),
      ).resolves.toBeDefined();
    });

    it('ignores CANCELLED showtimes', async () => {
      const { movie, room } = await roomWithShowtime('CANCELLED');

      await expect(
        fx.showtime({
          movieId: movie.id,
          roomId: room.id,
          startsAt: '2026-11-01T10:00:00Z',
          endsAt: '2026-11-01T12:00:00Z',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects re-activating a cancelled showtime that now overlaps', async () => {
      const { movie, room, existing } = await roomWithShowtime('CANCELLED');
      await fx.showtime({
        movieId: movie.id,
        roomId: room.id,
        startsAt: '2026-11-01T11:00:00Z',
        endsAt: '2026-11-01T13:00:00Z',
      });

      await expectViolation(
        prisma.showtime.update({ where: { id: existing.id }, data: { status: 'SCHEDULED' } }),
        NO_OVERLAP,
      );
    });
  });

  describe('showtimes_time_range_check', () => {
    it.each([
      ['ends before it starts', '2026-11-01T12:00:00Z', '2026-11-01T10:00:00Z'],
      ['has zero duration', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z'],
    ])('rejects a showtime that %s', async (_case, startsAt, endsAt) => {
      const [movie, room] = await Promise.all([fx.movie(), fx.room()]);

      await expectViolation(fx.showtime({ movieId: movie.id, roomId: room.id, startsAt, endsAt }), {
        sqlState: SQLSTATE.checkViolation,
        constraint: 'showtimes_time_range_check',
      });
    });
  });

  describe('showtime_seats status CHECKs', () => {
    const heldUntil = new Date('2026-11-01T09:15:00Z');

    it('rejects AVAILABLE with a booking (showtime_seats_available_check)', async () => {
      const { showtime, booking, seats } = await seatContext();

      await expectViolation(
        prisma.showtimeSeat.create({
          data: {
            showtimeId: showtime.id,
            seatId: seats[0]!.id,
            price: 90_000,
            status: 'AVAILABLE',
            bookingId: booking.id,
          },
        }),
        { sqlState: SQLSTATE.checkViolation, constraint: 'showtime_seats_available_check' },
      );
    });

    it.each([
      ['without booking_id', { heldUntil }],
      ['without held_until', { withBooking: true }],
      ['without either', {}],
    ])('rejects HELD %s (showtime_seats_held_check)', async (_case, input) => {
      const { showtime, booking, seats } = await seatContext();

      await expectViolation(
        prisma.showtimeSeat.create({
          data: {
            showtimeId: showtime.id,
            seatId: seats[0]!.id,
            price: 90_000,
            status: 'HELD',
            bookingId: 'withBooking' in input ? booking.id : null,
            heldUntil: 'heldUntil' in input ? input.heldUntil : null,
          },
        }),
        { sqlState: SQLSTATE.checkViolation, constraint: 'showtime_seats_held_check' },
      );
    });

    it('rejects SOLD without a booking (showtime_seats_sold_check)', async () => {
      const { showtime, seats } = await seatContext();

      await expectViolation(
        prisma.showtimeSeat.create({
          data: { showtimeId: showtime.id, seatId: seats[0]!.id, price: 90_000, status: 'SOLD' },
        }),
        { sqlState: SQLSTATE.checkViolation, constraint: 'showtime_seats_sold_check' },
      );
    });

    it('accepts every valid state', async () => {
      const { showtime, booking, seats } = await seatContext();
      const [available, held, sold] = seats;

      await expect(
        prisma.showtimeSeat.createMany({
          data: [
            { showtimeId: showtime.id, seatId: available!.id, price: 90_000 },
            {
              showtimeId: showtime.id,
              seatId: held!.id,
              price: 90_000,
              status: 'HELD',
              bookingId: booking.id,
              heldUntil,
            },
            {
              showtimeId: showtime.id,
              seatId: sold!.id,
              price: 90_000,
              status: 'SOLD',
              bookingId: booking.id,
            },
          ],
        }),
      ).resolves.toEqual({ count: 3 });
    });

    it('follows the hold → release → hold → sell lifecycle of PLAN section 4', async () => {
      const { showtime, booking, seats } = await seatContext();
      const key = { showtimeId_seatId: { showtimeId: showtime.id, seatId: seats[0]!.id } };
      await prisma.showtimeSeat.create({
        data: { showtimeId: showtime.id, seatId: seats[0]!.id, price: 90_000 },
      });

      // Hold
      await prisma.showtimeSeat.update({
        where: key,
        data: { status: 'HELD', bookingId: booking.id, heldUntil },
      });
      // Release must clear the owner, otherwise the CHECK rejects it.
      await expectViolation(
        prisma.showtimeSeat.update({ where: key, data: { status: 'AVAILABLE' } }),
        { sqlState: SQLSTATE.checkViolation, constraint: 'showtime_seats_available_check' },
      );
      await prisma.showtimeSeat.update({
        where: key,
        data: { status: 'AVAILABLE', bookingId: null, heldUntil: null },
      });
      // Hold again, then confirm.
      await prisma.showtimeSeat.update({
        where: key,
        data: { status: 'HELD', bookingId: booking.id, heldUntil },
      });
      await expect(
        prisma.showtimeSeat.update({ where: key, data: { status: 'SOLD' } }),
      ).resolves.toMatchObject({ status: 'SOLD', bookingId: booking.id });
    });
  });

  describe('tickets_showtime_id_seat_id_live_key (partial unique, status <> VOID)', () => {
    const LIVE_TICKET = {
      sqlState: SQLSTATE.uniqueViolation,
      constraint: 'tickets_showtime_id_seat_id_live_key',
    };

    async function soldSeat() {
      const { showtime, booking, seats } = await seatContext();
      const seatId = seats[0]!.id;
      await prisma.showtimeSeat.create({
        data: {
          showtimeId: showtime.id,
          seatId,
          price: 90_000,
          status: 'SOLD',
          bookingId: booking.id,
        },
      });
      const ticket = (status: 'ISSUED' | 'CHECKED_IN' | 'VOID' = 'ISSUED') =>
        prisma.ticket.create({
          data: {
            bookingId: booking.id,
            showtimeId: showtime.id,
            seatId,
            code: randomUUID(),
            status,
          },
        });
      return { ticket };
    }

    it('rejects a second live ticket for the same seat', async () => {
      const { ticket } = await soldSeat();
      await ticket();

      await expectViolation(ticket(), LIVE_TICKET);
    });

    it('treats CHECKED_IN as live too', async () => {
      const { ticket } = await soldSeat();
      await ticket('CHECKED_IN');

      await expectViolation(ticket(), LIVE_TICKET);
    });

    it('allows re-issuing after the previous ticket was voided', async () => {
      const { ticket } = await soldSeat();
      const first = await ticket();
      await prisma.ticket.update({ where: { id: first.id }, data: { status: 'VOID' } });

      await expect(ticket()).resolves.toBeDefined();
      await expect(ticket('VOID')).resolves.toBeDefined();
    });
  });

  describe('payments', () => {
    async function bookingWithPayments() {
      const { booking } = await seatContext();
      let n = 0;
      const payment = (status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED', vnpNo?: string) =>
        prisma.payment.create({
          data: {
            bookingId: booking.id,
            txnRef: `${booking.code}-${++n}`,
            amount: 90_000,
            status,
            vnpTransactionNo: vnpNo,
          },
        });
      return { booking, payment };
    }

    describe('payments_booking_id_success_key (partial unique, status = SUCCESS)', () => {
      const ONE_SUCCESS = {
        sqlState: SQLSTATE.uniqueViolation,
        constraint: 'payments_booking_id_success_key',
      };

      it('rejects a second SUCCESS payment for the same booking', async () => {
        const { payment } = await bookingWithPayments();
        await payment('SUCCESS');

        await expectViolation(payment('SUCCESS'), ONE_SUCCESS);
      });

      it('rejects turning a second attempt into SUCCESS', async () => {
        const { payment } = await bookingWithPayments();
        await payment('SUCCESS');
        const retry = await payment('PENDING');

        await expectViolation(
          prisma.payment.update({ where: { id: retry.id }, data: { status: 'SUCCESS' } }),
          ONE_SUCCESS,
        );
      });

      it('allows many non-successful attempts plus one SUCCESS', async () => {
        const { payment } = await bookingWithPayments();

        await expect(
          Promise.all([
            payment('FAILED'),
            payment('FAILED'),
            payment('EXPIRED'),
            payment('PENDING'),
          ]),
        ).resolves.toHaveLength(4);
        await expect(payment('SUCCESS')).resolves.toBeDefined();
      });

      it('allows SUCCESS payments on different bookings', async () => {
        const first = await bookingWithPayments();
        const second = await bookingWithPayments();

        await first.payment('SUCCESS');
        await expect(second.payment('SUCCESS')).resolves.toBeDefined();
      });
    });

    describe('payments_vnp_transaction_no_key (unique, NULLs distinct)', () => {
      it('allows any number of payments without a transaction number', async () => {
        const { payment } = await bookingWithPayments();

        await expect(
          Promise.all([payment('PENDING'), payment('FAILED'), payment('EXPIRED')]),
        ).resolves.toHaveLength(3);
      });

      it('rejects a duplicate transaction number', async () => {
        const first = await bookingWithPayments();
        const second = await bookingWithPayments();
        await first.payment('SUCCESS', '14123456');

        await expectViolation(second.payment('FAILED', '14123456'), {
          sqlState: SQLSTATE.uniqueViolation,
          constraint: 'payments_vnp_transaction_no_key',
        });
      });
    });
  });

  describe('vouchers (ROADMAP 5.1)', () => {
    let n = 0;
    /** A valid voucher with a fresh code; `data` overrides any field. */
    const voucher = (data: Partial<Prisma.VoucherUncheckedCreateInput> = {}) =>
      prisma.voucher.create({
        data: {
          code: `DB${String(++n).padStart(6, '0')}`,
          discountType: 'PERCENT',
          discountValue: 10,
          startsAt: new Date('2026-11-01T00:00:00Z'),
          endsAt: new Date('2026-12-01T00:00:00Z'),
          ...data,
        },
      });
    const check = (constraint: string) => ({ sqlState: SQLSTATE.checkViolation, constraint });

    it.each([
      ['lower case', 'summer10'],
      ['too short', 'AB1'],
      ['too long', 'A'.repeat(21)],
      ['a hyphen', 'SUMMER-10'],
      ['a Vietnamese letter', 'GIẢMGIÁ'],
    ])('vouchers_code_format_check rejects a code with %s', async (_case, code) => {
      await expectViolation(voucher({ code }), check('vouchers_code_format_check'));
    });

    it.each([
      ['PERCENT 0', { discountType: 'PERCENT', discountValue: 0 }],
      ['PERCENT 101', { discountType: 'PERCENT', discountValue: 101 }],
      ['PERCENT with a zero cap', { discountType: 'PERCENT', maxDiscount: 0 }],
      ['FIXED 0', { discountType: 'FIXED', discountValue: 0 }],
      ['FIXED with a cap', { discountType: 'FIXED', discountValue: 20_000, maxDiscount: 20_000 }],
    ] as const)('vouchers_discount_check rejects %s', async (_case, data) => {
      await expectViolation(voucher(data), check('vouchers_discount_check'));
    });

    it.each([
      ['a negative min subtotal', { minSubtotal: -1 }],
      ['a usage limit of 0', { usageLimit: 0 }],
      ['a per-user limit of 0', { perUserLimit: 0 }],
    ])('vouchers_limits_check rejects %s', async (_case, data) => {
      await expectViolation(voucher(data), check('vouchers_limits_check'));
    });

    it('vouchers_time_range_check rejects a voucher that ends when it starts', async () => {
      const at = new Date('2026-11-01T00:00:00Z');
      await expectViolation(
        voucher({ startsAt: at, endsAt: at }),
        check('vouchers_time_range_check'),
      );
    });

    it('accepts every valid shape', async () => {
      await expect(
        Promise.all([
          voucher({ discountValue: 1 }),
          voucher({ discountValue: 100, maxDiscount: 50_000 }),
          voucher({ discountType: 'FIXED', discountValue: 20_000, minSubtotal: 100_000 }),
          voucher({ usageLimit: 1, perUserLimit: 1 }),
          voucher({ code: 'A'.repeat(20) }),
        ]),
      ).resolves.toHaveLength(5);
    });

    it('rejects a second voucher usage for one booking (voucher_usages_booking_id_key)', async () => {
      const { user, booking } = await seatContext();
      const [first, second] = await Promise.all([voucher(), voucher()]);
      const usage = (voucherId: string) =>
        prisma.voucherUsage.create({ data: { voucherId, userId: user.id, bookingId: booking.id } });
      await usage(first.id);

      await expectViolation(usage(second.id), {
        sqlState: SQLSTATE.uniqueViolation,
        constraint: 'voucher_usages_booking_id_key',
      });
    });

    it('refuses to delete a voucher that a booking used (ON DELETE RESTRICT)', async () => {
      const { user, booking } = await seatContext();
      const used = await voucher();
      await prisma.voucherUsage.create({
        data: { voucherId: used.id, userId: user.id, bookingId: booking.id, status: 'RELEASED' },
      });

      await expectViolation(prisma.voucher.delete({ where: { id: used.id } }), {
        sqlState: '23503', // foreign_key_violation

        constraint: 'voucher_usages_voucher_id_fkey',
      });
    });
  });
});
