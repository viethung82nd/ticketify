// Scenario 2 (PLAN §10): ordinary traffic spread over the whole catalogue. Each iteration is one
// visitor doing one thing, drawn with these weights:
//   35 %  browse the movie list (a tenth of them with a title search)
//   20 %  open a movie: detail + the days it is on
//   25 %  pick a day: that day's showtimes + one seat map
//    5 %  look at "my bookings"
//   15 %  book: seat map, hold 1–4 adjacent free seats, and a third of the winners cancel
// Showtimes are drawn from every future load showtime (not the hot one), so holds rarely collide:
// this measures the everyday cost of each endpoint, scenario 1 measures contention.
//
//   RATE (default 50 iterations/s), DURATION (default 3m), PRE_VUS, MAX_VUS, MAX_SEATS
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import {
  authHeaders,
  BASE_URL,
  chooseSeats,
  errorCode,
  HOLD_EXPECTED,
  idempotencyKey,
  loadData,
  nextUser,
  pick,
  SUMMARY_TREND_STATS,
  summaryOutputs,
} from './lib/common.js';

const RATE = Number(__ENV.RATE || 50);
const DURATION = __ENV.DURATION || '3m';
const PRE_VUS = Number(__ENV.PRE_VUS || 30);
const MAX_VUS = Number(__ENV.MAX_VUS || 300);
const MAX_SEATS = Number(__ENV.MAX_SEATS || 4);

const holdsCreated = new Counter('holds_created');
const holdsRefused = new Counter('holds_refused');
const cancels = new Counter('bookings_cancelled');

const ACTIONS = [
  [35, browse],
  [20, movieDetail],
  [25, showtimesOfDay],
  [5, myBookings],
  [15, book],
];
const TOTAL_WEIGHT = ACTIONS.reduce((sum, [w]) => sum + w, 0);

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      exec: 'visit',
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:movies_list}': ['p(95)<300'],
    'http_req_duration{name:movies_search}': ['p(95)<300'],
    'http_req_duration{name:movie_detail}': ['p(95)<300'],
    'http_req_duration{name:showtime_dates}': ['p(95)<300'],
    'http_req_duration{name:showtime_list}': ['p(95)<300'],
    'http_req_duration{name:seat_map}': ['p(95)<300'],
    'http_req_duration{name:my_bookings}': ['p(95)<300'],
    'http_req_duration{name:hold}': ['p(95)<500'],
    'http_req_duration{name:cancel}': ['p(95)<500'],
  },
};

const ok = (res, name) => check(res, { [`${name} 200`]: (r) => r.status === 200 });

function browse() {
  const page = 1 + Math.floor(Math.random() * 3);
  if (Math.random() < 0.1) {
    const q = `load phim ${Math.floor(Math.random() * 10)}`;
    const res = http.get(`${BASE_URL}/movies?q=${encodeURIComponent(q)}&pageSize=12`, {
      tags: { name: 'movies_search' },
    });
    ok(res, 'movies_search');
    return;
  }
  const status = Math.random() < 0.8 ? 'NOW_SHOWING' : 'COMING_SOON';
  const res = http.get(`${BASE_URL}/movies?status=${status}&page=${page}&pageSize=12`, {
    tags: { name: 'movies_list' },
  });
  ok(res, 'movies_list');
}

function movieDetail() {
  const movie = pick(loadData().movies);
  ok(
    http.get(`${BASE_URL}/movies/${movie.slug}`, { tags: { name: 'movie_detail' } }),
    'movie_detail',
  );
  ok(
    http.get(`${BASE_URL}/showtimes/dates?movieId=${movie.id}`, {
      tags: { name: 'showtime_dates' },
    }),
    'showtime_dates',
  );
}

function showtimesOfDay() {
  const showtime = pick(loadData().futureShowtimes);
  ok(
    http.get(`${BASE_URL}/showtimes?movieId=${showtime.movieId}&date=${showtime.day}`, {
      tags: { name: 'showtime_list' },
    }),
    'showtime_list',
  );
  ok(
    http.get(`${BASE_URL}/showtimes/${showtime.id}/seats`, { tags: { name: 'seat_map' } }),
    'seat_map',
  );
}

function myBookings(user) {
  ok(
    http.get(`${BASE_URL}/me/bookings?page=1`, {
      headers: authHeaders(user),
      tags: { name: 'my_bookings' },
    }),
    'my_bookings',
  );
}

function book(user) {
  const showtime = pick(loadData().futureShowtimes);
  const map = http.get(`${BASE_URL}/showtimes/${showtime.id}/seats`, {
    tags: { name: 'seat_map' },
  });
  if (!ok(map, 'seat_map')) return;
  const seatIds = chooseSeats(map.json('seats'), MAX_SEATS);
  if (seatIds.length === 0) return;

  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({ showtimeId: showtime.id, seatIds }),
    {
      headers: authHeaders(user, { 'Idempotency-Key': idempotencyKey() }),
      tags: { name: 'hold' },
      responseCallback: HOLD_EXPECTED,
    },
  );
  check(res, { 'hold 201 or 409': (r) => r.status === 201 || r.status === 409 });
  if (res.status !== 201) {
    holdsRefused.add(1, { code: `${res.status} ${errorCode(res)}` });
    return;
  }
  holdsCreated.add(1);
  if (Math.random() < 1 / 3) {
    const cancel = http.del(`${BASE_URL}/bookings/${res.json('id')}`, null, {
      headers: authHeaders(user),
      tags: { name: 'cancel' },
    });
    if (check(cancel, { 'cancel 204': (r) => r.status === 204 })) cancels.add(1);
  }
}

export function visit() {
  const user = nextUser();
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const [weight, action] of ACTIONS) {
    roll -= weight;
    if (roll < 0) return action(user);
  }
}

export function handleSummary(data) {
  return summaryOutputs(data, {
    script: 'mixed-traffic',
    baseUrl: BASE_URL,
    rate: RATE,
    duration: DURATION,
    preAllocatedVUs: PRE_VUS,
    maxVUs: MAX_VUS,
    maxSeats: MAX_SEATS,
    weights: ACTIONS.map(([w, fn]) => `${fn.name}:${w}`).join(' '),
  });
}
