import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect } from '@playwright/test';
import { API_URL } from '../../playwright.config';

/** The seeded admin (prisma/seed.ts); its password is the one the database was seeded with. */
const ADMIN = {
  email: 'admin@ticketify.local',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'dev-admin-password',
};

export interface Scene {
  movie: { id: string; slug: string; title: string };
  room: { id: string; name: string };
  showtime: { id: string; startsAt: string };
  /** `YYYY-MM-DD` of the showtime on the cinema's calendar. */
  date: string;
  user: { email: string; password: string; fullName: string };
}

/** Tomorrow in Vietnam, `YYYY-MM-DD`. */
const tomorrowInVietnam = (): string =>
  new Date(Date.now() + (7 + 24) * 3_600_000).toISOString().slice(0, 10);

/**
 * Everything the flow needs, made through the API as an admin would: a fresh 4 × 6 room (so a
 * rerun never meets an earlier run's showtime), one showtime in it tomorrow evening, and a new
 * customer account. The movie is the first one the catalogue lists.
 */
export async function createScene(request: APIRequestContext): Promise<Scene> {
  const login = await request.post(`${API_URL}/auth/login`, { data: ADMIN });
  expect(login.status(), 'admin login (E2E_ADMIN_PASSWORD = the seed password)').toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { Authorization: `Bearer ${accessToken}` };

  const movies = (await (await request.get(`${API_URL}/movies`)).json()) as {
    items: Scene['movie'][];
  };
  const movie = movies.items[0];
  expect(movie, 'the seed has at least one movie').toBeDefined();

  const tag = randomUUID().slice(0, 8);
  const roomRes = await request.post(`${API_URL}/admin/rooms`, {
    headers,
    data: { name: `Phòng E2E ${tag}`, rows: 4, cols: 6 },
  });
  expect(roomRes.status()).toBe(201);
  const room = (await roomRes.json()) as Scene['room'];

  const date = tomorrowInVietnam();
  const showtimeRes = await request.post(`${API_URL}/admin/showtimes`, {
    headers,
    data: { movieId: movie!.id, roomId: room.id, startsAt: `${date}T19:30:00+07:00` },
  });
  expect(showtimeRes.status()).toBe(201);
  const showtime = (await showtimeRes.json()) as Scene['showtime'];

  const user = {
    email: `e2e-${tag}@test.local`,
    password: 'e2e-Password-123',
    fullName: 'Khách E2E',
  };
  const register = await request.post(`${API_URL}/auth/register`, { data: user });
  expect(register.status()).toBe(201);

  return { movie: movie!, room, showtime, date, user };
}
