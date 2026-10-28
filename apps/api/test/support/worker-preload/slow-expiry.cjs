// Preloaded into a worker process by worker-shutdown.int-spec (`node -r <this> main.worker.js`).
//
// Makes every expiry hang inside its transaction, AFTER its writes and BEFORE the commit, on a
// statement that lock_timeout does not end (pg_sleep): the case the shutdown deadline exists for
// (a slow query, a stalled connection). Nothing in src/ knows about it.
//
//   SLOW_EXPIRY_MODULE   absolute path of the compiled expire-booking.js
//   SLOW_EXPIRY_SECONDS  how long the statement runs
'use strict';

const target = process.env.SLOW_EXPIRY_MODULE;
const seconds = Number(process.env.SLOW_EXPIRY_SECONDS);
if (!target || !(seconds > 0)) {
  throw new Error('SLOW_EXPIRY_MODULE and SLOW_EXPIRY_SECONDS are required');
}

// Compiled CommonJS: callers read `expireBooking` off this exports object at call time.
const expiry = require(target);
const realExpireBooking = expiry.expireBooking;
expiry.expireBooking = async function slowExpireBooking(tx, bookingId, now) {
  const outcome = await realExpireBooking(tx, bookingId, now);
  await tx.$queryRawUnsafe(`SELECT pg_sleep(${seconds})`);
  return outcome;
};
