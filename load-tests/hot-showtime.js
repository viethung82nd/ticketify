// Scenario 1 (PLAN §10): a crowd rushes ONE showtime. Each iteration is one customer: load the
// seat map, pick 1–4 adjacent seats that look free, try to hold them. Most attempts lose a race
// (409 SEAT_LOCKED / SEAT_UNAVAILABLE) or find the room full; that is the point — the run shows
// how fast the losing path is and that no seat ends up held twice (checked in SQL afterwards).
//
//   RATE        iterations started per second (constant-arrival-rate), default 100
//   DURATION    default 2m
//   PRE_VUS / MAX_VUS   VUs k6 keeps ready / may add when responses slow down
//   MAX_SEATS   seats per attempt, 1–6 (BOOKING_LIMITS.seatsMax), default 4
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
  loadMeta,
  nextUser,
  SUMMARY_TREND_STATS,
  summaryOutputs,
} from './lib/common.js';

const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '2m';
const PRE_VUS = Number(__ENV.PRE_VUS || 50);
const MAX_VUS = Number(__ENV.MAX_VUS || 500);
const MAX_SEATS = Number(__ENV.MAX_SEATS || 4);

const holdsCreated = new Counter('holds_created');
const holdsLost = new Counter('holds_lost_race');
const holdsRejected = new Counter('holds_rejected_other');
const soldOutViews = new Counter('sold_out_views');

export const options = {
  scenarios: {
    hot_showtime: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      exec: 'rush',
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    // Targets, not hacks: a 5xx or a timeout is a failure; 409 is a lost race, not an error.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:seat_map}': ['p(95)<500'],
    'http_req_duration{name:hold}': ['p(95)<500'],
  },
};

export function rush() {
  const { hotShowtimeId } = loadMeta();
  const user = nextUser();
  const map = http.get(`${BASE_URL}/showtimes/${hotShowtimeId}/seats`, {
    tags: { name: 'seat_map' },
  });
  if (!check(map, { 'seat map 200': (r) => r.status === 200 })) return;

  const seatIds = chooseSeats(map, MAX_SEATS);
  if (seatIds.length === 0) {
    soldOutViews.add(1);
    return;
  }
  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({ showtimeId: hotShowtimeId, seatIds }),
    {
      headers: authHeaders(user, { 'Idempotency-Key': idempotencyKey() }),
      tags: { name: 'hold' },
      responseCallback: HOLD_EXPECTED,
    },
  );
  check(res, { 'hold 201 or 409': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 201) holdsCreated.add(1);
  else if (res.status === 409) {
    const code = errorCode(res);
    if (code === 'SEAT_LOCKED' || code === 'SEAT_UNAVAILABLE') holdsLost.add(1, { code });
    else holdsRejected.add(1, { code });
  } else holdsRejected.add(1, { code: `${res.status} ${errorCode(res)}` });
}

export function handleSummary(data) {
  return summaryOutputs(data, {
    script: 'hot-showtime',
    baseUrl: BASE_URL,
    rate: RATE,
    duration: DURATION,
    preAllocatedVUs: PRE_VUS,
    maxVUs: MAX_VUS,
    maxSeats: MAX_SEATS,
    hotShowtimeId: loadMeta().hotShowtimeId,
  });
}
