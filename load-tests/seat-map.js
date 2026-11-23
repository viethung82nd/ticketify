// Single-endpoint benchmark of the seat map (GET /showtimes/:id/seats), the most expensive public
// endpoint in 6.2. Used by 6.3 to compare the API before and after a change at the same arrival
// rates. Each iteration asks for the map of a random future showtime; the body is received but
// not handed to JavaScript (responseType none), so k6 itself stays cheap.
//
//   RATE (default 100 requests/s), DURATION (default 1m), PRE_VUS, MAX_VUS
import http from 'k6/http';
import { check } from 'k6';
import {
  BASE_URL,
  futureShowtimes,
  pick,
  SUMMARY_TREND_STATS,
  summaryOutputs,
} from './lib/common.js';

const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '1m';
const PRE_VUS = Number(__ENV.PRE_VUS || 30);
const MAX_VUS = Number(__ENV.MAX_VUS || 300);

export const options = {
  scenarios: {
    seat_map: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      exec: 'seatMap',
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:seat_map}': ['p(95)<300'],
  },
};

export function seatMap() {
  const showtime = pick(futureShowtimes);
  const res = http.get(`${BASE_URL}/showtimes/${showtime.id}/seats`, {
    tags: { name: 'seat_map' },
    responseType: 'none',
  });
  check(res, { 'seat map 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return summaryOutputs(data, {
    script: 'seat-map',
    baseUrl: BASE_URL,
    rate: RATE,
    duration: DURATION,
    preAllocatedVUs: PRE_VUS,
    maxVUs: MAX_VUS,
  });
}
