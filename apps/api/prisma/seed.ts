/**
 * Development seed. Idempotent: every write is an upsert keyed on a natural unique key,
 * so it can run any number of times.  Run: pnpm db:seed
 */
import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client';
import { DayType, SeatType } from '../src/generated/prisma/enums';
import { buildRoomLayout, GENRES, MOVIES, ROOM, SEAT_PRICES, USERS } from './seed/data';
import { loadSeedEnv, type SeedEnv } from './seed/env';

loadEnv({ path: ['.env', '../../.env'], quiet: true });

async function seedUsers(prisma: PrismaClient, env: SeedEnv): Promise<void> {
  for (const user of USERS) {
    // argon2id with library defaults (OWASP-recommended parameters).
    const passwordHash = await hash(env[user.passwordEnv]);
    await prisma.user.upsert({
      where: { email: user.email },
      update: { fullName: user.fullName, role: user.role, passwordHash },
      create: { email: user.email, fullName: user.fullName, role: user.role, passwordHash },
    });
  }
}

async function seedPrices(prisma: PrismaClient): Promise<void> {
  for (const seatType of Object.values(SeatType)) {
    for (const dayType of Object.values(DayType)) {
      const price = SEAT_PRICES[seatType][dayType];
      await prisma.seatPrice.upsert({
        where: { seatType_dayType: { seatType, dayType } },
        update: { price },
        create: { seatType, dayType, price },
      });
    }
  }
}

async function seedRoom(prisma: PrismaClient): Promise<void> {
  const room = await prisma.room.upsert({
    where: { name: ROOM.name },
    update: { rows: ROOM.rows, cols: ROOM.cols },
    create: { name: ROOM.name, rows: ROOM.rows, cols: ROOM.cols },
  });
  await prisma.$transaction(
    buildRoomLayout(ROOM.rows, ROOM.cols).map((seat) =>
      prisma.seat.upsert({
        where: { roomId_row_number: { roomId: room.id, row: seat.row, number: seat.number } },
        update: { type: seat.type, coupleGroup: seat.coupleGroup, isActive: true },
        create: { roomId: room.id, ...seat },
      }),
    ),
  );
}

async function seedCatalog(prisma: PrismaClient): Promise<void> {
  const genreIds = new Map<string, string>();
  for (const genre of GENRES) {
    const row = await prisma.genre.upsert({
      where: { slug: genre.slug },
      update: { name: genre.name },
      create: genre,
    });
    genreIds.set(genre.slug, row.id);
  }

  for (const { genres, releaseDate, ...movie } of MOVIES) {
    const links = genres.map((slug) => ({ genreId: genreIds.get(slug)! }));
    const data = { ...movie, releaseDate: new Date(releaseDate) };
    await prisma.movie.upsert({
      where: { slug: movie.slug },
      // Replace genre links so the movie always matches the seed definition.
      update: { ...data, genres: { deleteMany: {}, create: links } },
      create: { ...data, genres: { create: links } },
    });
  }
}

async function main(): Promise<void> {
  const env = loadSeedEnv(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    await seedUsers(prisma, env);
    await seedPrices(prisma);
    await seedRoom(prisma);
    await seedCatalog(prisma);

    const [users, seats, prices, movies] = await Promise.all([
      prisma.user.count(),
      prisma.seat.count(),
      prisma.seatPrice.count(),
      prisma.movie.count(),
    ]);
    console.log(`Seed done: ${users} users, ${seats} seats, ${prices} prices, ${movies} movies`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
