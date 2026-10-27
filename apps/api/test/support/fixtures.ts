import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { ShowtimeStatus } from '../../src/generated/prisma/enums';

/** Minimal valid rows for tests. Every call creates new, uniquely named records. */
export function createFixtures(prisma: PrismaClient) {
  const unique = (): string => randomUUID().slice(0, 8);

  return {
    user: () =>
      prisma.user.create({
        data: {
          email: `user-${unique()}@test.local`,
          passwordHash: 'not-a-real-hash',
          fullName: 'Test User',
        },
      }),

    movie: () =>
      prisma.movie.create({
        data: {
          title: 'Test Movie',
          slug: `test-movie-${unique()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: new Date('2026-10-01'),
        },
      }),

    room: () => prisma.room.create({ data: { name: `Room ${unique()}`, rows: 1, cols: 4 } }),

    seat: (roomId: string, number: number) =>
      prisma.seat.create({ data: { roomId, row: 'A', number } }),

    showtime: (input: {
      movieId: string;
      roomId: string;
      startsAt: string;
      endsAt: string;
      status?: ShowtimeStatus;
    }) =>
      prisma.showtime.create({
        data: {
          movieId: input.movieId,
          roomId: input.roomId,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          status: input.status,
        },
      }),

    booking: (userId: string, showtimeId: string) =>
      prisma.booking.create({
        data: {
          code: `BK${unique()}`,
          userId,
          showtimeId,
          subtotal: 90_000,
          total: 90_000,
          expiresAt: new Date('2026-11-01T09:10:00Z'),
          holdUntil: new Date('2026-11-01T09:15:00Z'),
          idempotencyKey: randomUUID(),
          requestHash: 'hash',
        },
      }),
  };
}

export type Fixtures = ReturnType<typeof createFixtures>;
