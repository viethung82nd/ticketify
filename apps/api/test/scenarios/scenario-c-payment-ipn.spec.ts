import { performance } from 'node:perf_hooks';
import { type Booking, type CreatedVnpayPayment, Role } from '@ticketify/shared';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import type { ExpireOutcome } from '../../src/modules/bookings/expire-booking';
import { VnpayService } from '../../src/modules/payment/vnpay/vnpay.service';
import { formatServerErrors } from '../support/server-errors';
import { ipnClient, type IpnOutcome, tallyIpn } from './support/ipn-client';
import {
  formatPaymentViolations,
  NO_PAYMENT_VIOLATIONS,
  paymentViolations,
} from './support/payment-checks';
import { type PoolUsage, samplePool } from './support/pool-sampler';
import { random } from './support/random';
import {
  bootScenarioApp,
  SCENARIO_POOL_MAX,
  type ScenarioApp,
  type ScenarioRoom,
  type ScenarioWorker,
  describeScenario,
} from './support/scenario-app';
import { percentile, writeReport } from './support/stats';

/**
 * Scenario C (PLAN §10, ROADMAP 3.9): the VNPay IPN under the conditions that actually go wrong in
 * production — the same IPN arriving many times at once, a forged one, a wrong amount, one that
 * lands inside the payment grace period, one that lands after the seat was sold to somebody else,
 * and one racing the booking expiry.
 *
 * Every case asserts the **final state in the database**, not the answer: the whole-database rules
 * of `support/payment-checks.ts` (one live ticket per seat, a CONFIRMED booking owning all of its
 * seats SOLD, a consistent booking/seat/payment triple, exactly one outbox event per settled
 * booking) are checked after each case and after each round of the race. An IPN that answers `00`
 * while leaving two tickets on one seat is a failure however right its answer looked.
 *
 * No request leaves the machine: the IPNs are built here and signed with this suite's own test
 * secret, exactly as `payment-ipn.int-spec.ts` and `vnpay-ipn.spec.ts` do (the sandbox credentials
 * are registered by hand and are not in the repo). Paying on the real sandbox is ROADMAP 3.6, on
 * hold.
 *
 * Like scenario B this runs on every platform: all of its assertions are about answers and rows.
 * The one exception is the pool assertion of the duplicate-IPN burst, gated below.
 */

/**
 * Only the duplicate-IPN burst asserts on pool use, and only off Windows — the same reason as
 * scenario A: there the API runs on the host while Postgres is in Docker Desktop, so a burst
 * leaves the pool fully busy with connections that are `idle in transaction` (waiting for the API
 * to send its next statement, not working in Postgres). The answers and the rows are still right
 * and are still asserted there; only `maxBusy < pool` is accepted on Linux (the
 * `booking-scenarios` workflow). The numbers are printed on every platform.
 */
const POOL_ASSERTED = process.platform !== 'win32';

/** IPNs sent at the same instant for one payment (VNPay retries up to 10 times; 40 is slack). */
const DUPLICATES = Number(process.env.SCENARIO_C_DUPLICATES ?? 40);
/** Forged IPNs sent at once in the bad-signature case. */
const FORGERIES = 20;
/** Rounds of the expiry race, each on a fresh showtime. */
const RACE_ROUNDS = Number(process.env.SCENARIO_C_ROUNDS ?? 20);
/** Random start offset of each side of a race (ms), on top of the head start. */
const RACE_MAX_DELAY_MS = 40;
/**
 * Head start the slower side of a round gets. The IPN travels over HTTP (tens of milliseconds)
 * while the expiry is a direct in-process call, so jitter alone lets the IPN commit first in
 * nearly every round and the other order — the expiry taking the seats back before the money
 * lands, branch B — would never be reached. Half the rounds hand the head start to the expiry.
 */
const RACE_HEAD_START_MS = 60;
const SEED = 20_261_106;

/** Test-only merchant settings; never real secrets. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'scenario-c-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
  /**
   * Nothing listens here, on purpose. With the merchant settings set, the expiry asks VNPay about
   * a pending payment before giving its seats up (querydr, ROADMAP 3.7) — and a scenario must
   * never send a request off this machine. `fetch` is stubbed as well (see `beforeEach`); this is
   * the second lock, so a querydr call that somehow slipped past the stub still cannot leave.
   */
  VNPAY_API_URL: 'http://127.0.0.1:1/merchant_webapi/api/transaction',
  VNPAY_QUERYDR_TIMEOUT_MS: '500',
  // Every case starts several payments; the per-user limit is not what is under test here.
  PAYMENT_RATE_LIMIT_MAX: '1000',
} as const;

/** Defaults of the env schema, repeated so the arithmetic below is readable. */
const HOLD_TTL_MINUTES = 10;
const PAYMENT_GRACE_MINUTES = 5;
/** Past holdUntil: the booking is due for expiry. */
const HOLD_MINUTES = HOLD_TTL_MINUTES + PAYMENT_GRACE_MINUTES;

const OK = { RspCode: '00', Message: 'Confirm Success' };
const ALREADY = { RspCode: '02', Message: 'Order already confirmed' };
const BAD_AMOUNT = { RspCode: '04', Message: 'Invalid amount' };
const BAD_SIGNATURE = { RspCode: '97', Message: 'Invalid signature' };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Paid {
  userId: string;
  booking: Booking;
  payment: CreatedVnpayPayment;
  seatIds: string[];
  showtimeId: string;
}

/** What one case or round is reported as. */
interface CaseResult {
  name: string;
  requests: number;
  ms: number;
  answers: Record<string, number>;
  bookingStatus: string;
  tickets: number;
  outbox: string[];
  violations: string[];
}

describeScenario('Scenario C — the VNPay IPN under stress', () => {
  let scenario: ScenarioApp;
  let worker: ScenarioWorker;
  let room: ScenarioRoom;
  const vnpay = new VnpayService();
  const results: CaseResult[] = [];
  let poolUsage: PoolUsage | null = null;

  beforeAll(async () => {
    scenario = await bootScenarioApp('c', { env: { ...VNPAY_ENV }, worker: true });
    const booted = scenario.worker;
    if (!booted) throw new Error('Scenario C needs the worker module');
    worker = booted;
    // 4 × 12 so a case can take a whole row without touching another's seats.
    room = await scenario.room(4, 12);
  });

  /**
   * No request ever leaves this machine. The expiry asks VNPay about a pending payment before
   * giving its seats up (querydr, ROADMAP 3.7); here that call fails at once, as it would with
   * VNPay unreachable, so the expiry behaves exactly as it did before 3.7 and the race below is
   * decided by the database alone. querydr's own branches are covered by
   * `test/integration/payment-querydr.int-spec.ts`. Re-applied per test: `clearMocks` is on.
   */
  beforeEach(() => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.reject(new TypeError('fetch failed: a scenario never calls VNPay')),
      );
  });
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    const summary = {
      cases: results.length,
      failed: results.filter((r) => r.violations.length > 0).length,
      requests: results.reduce((sum, r) => sum + r.requests, 0),
      violations: results.reduce((sum, r) => sum + r.violations.length, 0),
    };
    const path = writeReport('scenario-c', {
      seed: SEED,
      duplicates: DUPLICATES,
      raceRounds: RACE_ROUNDS,
      platform: process.platform,
      poolAsserted: POOL_ASSERTED,
      poolMax: SCENARIO_POOL_MAX,
      pool: poolUsage,
      summary,
      results,
    });
    console.info(`[scenario C] summary ${JSON.stringify(summary)}; report: ${path}`);
    await scenario?.close();
  });

  // ─── Helpers ───

  const http = () => request(scenario.app.getHttpServer());
  /** Signed at the clock's current "now": tokens live 15 minutes on that clock, which moves here. */
  const tokenOf = (userId: string) =>
    scenario.app.get(AccessTokenIssuer).issue({ id: userId, role: Role.USER }).token;

  async function newUserId(): Promise<string> {
    const [user] = await scenario.users(1);
    if (!user) throw new Error('No user created');
    return user.id;
  }

  /** A user, a PENDING booking of `labels` and one PENDING payment for it, at the clock's now. */
  async function bookAndPay(showtimeId: string, labels: readonly string[]): Promise<Paid> {
    const userId = await newUserId();
    const seatIds = labels.map((label) => room.seat(label));
    const held = await http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(userId)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });
    if (held.status !== 201) throw new Error(`Hold: ${held.status} ${held.text}`);
    const booking = held.body as Booking;
    const started = await http()
      .post('/payments/vnpay')
      .set('Authorization', `Bearer ${tokenOf(userId)}`)
      .send({ bookingId: booking.id });
    if (started.status !== 201) throw new Error(`Payment: ${started.status} ${started.text}`);
    return {
      userId,
      booking,
      payment: started.body as CreatedVnpayPayment,
      seatIds: [...seatIds].sort(),
      showtimeId,
    };
  }

  let transactionNo = 17_550_000;
  /** The IPN VNPay would send for `paid`, signed with the test secret unless told otherwise. */
  function ipnQuery(
    paid: Pick<Paid, 'payment' | 'booking'>,
    overrides: Record<string, string> = {},
    secret: string = VNPAY_ENV.VNPAY_HASH_SECRET,
  ): Record<string, string> {
    transactionNo += 1;
    const query = vnpay.buildSignedQuery(
      {
        vnp_Amount: String(paid.booking.total * 100),
        vnp_BankCode: 'NCB',
        vnp_BankTranNo: `VNP${transactionNo}`,
        vnp_CardType: 'ATM',
        vnp_OrderInfo: `Thanh toan ve ${paid.booking.code}`,
        vnp_PayDate: '20261101170500',
        vnp_ResponseCode: '00',
        vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
        vnp_TransactionNo: String(transactionNo),
        vnp_TransactionStatus: '00',
        vnp_TxnRef: paid.payment.txnRef,
        ...overrides,
      },
      secret,
    );
    return Object.fromEntries(new URLSearchParams(query));
  }

  /** Everything a case checks for one booking, read after the dust has settled. */
  async function stateOf(paid: Pick<Paid, 'booking' | 'showtimeId' | 'seatIds'>) {
    const { prisma } = scenario.db;
    const [booking, payments, seats, tickets, events] = await Promise.all([
      prisma.booking.findUniqueOrThrow({
        where: { id: paid.booking.id },
        select: { status: true, confirmedAt: true },
      }),
      prisma.payment.findMany({
        where: { bookingId: paid.booking.id },
        select: { status: true, vnpTransactionNo: true, processedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.showtimeSeat.findMany({
        where: { showtimeId: paid.showtimeId, seatId: { in: paid.seatIds } },
        select: { seatId: true, status: true, bookingId: true, heldUntil: true },
        orderBy: { seatId: 'asc' },
      }),
      prisma.ticket.findMany({
        where: { bookingId: paid.booking.id },
        select: { seatId: true, status: true },
        orderBy: { seatId: 'asc' },
      }),
      prisma.outboxEvent.findMany({
        where: { aggregateId: paid.booking.id },
        select: { type: true },
      }),
    ]);
    return { booking, payments, seats, tickets, events: events.map((e) => e.type).sort() };
  }

  /** The whole-database rules, as readable violations. Empty = all good. */
  async function violationsNow(): Promise<string[]> {
    const found = await paymentViolations(scenario.db.prisma);
    expect(found).toEqual(NO_PAYMENT_VIOLATIONS);
    return formatPaymentViolations(found);
  }

  function record(result: CaseResult): void {
    results.push(result);
    console.info(
      `[scenario C] ${result.name}: ${result.requests} request(s) in ${result.ms} ms, ` +
        `${JSON.stringify(result.answers)}, booking ${result.bookingStatus}, ` +
        `${result.tickets} ticket(s), outbox [${result.outbox.join(', ')}]` +
        (result.violations.length > 0 ? `, VIOLATIONS ${JSON.stringify(result.violations)}` : ''),
    );
  }

  /** Sends `queries` all at once and reports what came back. */
  async function burst(queries: Record<string, string>[]): Promise<{
    outcomes: IpnOutcome[];
    ms: number;
    pool: PoolUsage;
  }> {
    const client = ipnClient(scenario.baseUrl);
    const pool = await samplePool(scenario.db.url, scenario.applicationName, SCENARIO_POOL_MAX);
    const started = performance.now();
    const outcomes = await Promise.all(queries.map((query) => client.send(query)));
    const ms = Math.round(performance.now() - started);
    const usage = await pool.stop();
    client.destroy();
    return { outcomes, ms, pool: usage };
  }

  const bodiesOf = (outcomes: readonly IpnOutcome[]) =>
    outcomes.map((o) => ({ RspCode: o.rspCode, Message: o.message }));

  /**
   * One expiry of the race, after `delay` ms. An expiry that throws is a finding, so it is
   * reported as an outcome of its own instead of failing the round before the state is read.
   */
  type RaceExpiry = ExpireOutcome | { outcome: 'threw'; error: string };
  const runExpiry = async (bookingId: string, delay: number): Promise<RaceExpiry> => {
    await pause(delay);
    try {
      return await worker.expiry.expire(bookingId);
    } catch (error) {
      return { outcome: 'threw', error: error instanceof Error ? error.message : String(error) };
    }
  };

  // ─── C1: the same IPN many times at once ───

  it(`1 — ${DUPLICATES} identical IPNs at once: one 00, the rest 02, one ticket per seat`, async () => {
    const showtime = await scenario.showtime(room.id);
    const paid = await bookAndPay(showtime.id, ['A1', 'A2']);
    // VNPay retries the same IPN, so every copy carries the same parameters, signature included.
    const query = ipnQuery(paid);
    scenario.serverErrors.splice(0);

    const { outcomes, ms, pool } = await burst(Array.from({ length: DUPLICATES }, () => query));
    poolUsage = pool;

    const state = await stateOf(paid);
    const found = await violationsNow();
    record({
      name: 'C1 duplicate IPN',
      requests: DUPLICATES,
      ms,
      answers: tallyIpn(outcomes),
      bookingStatus: state.booking.status,
      tickets: state.tickets.length,
      outbox: state.events,
      violations: found,
    });
    console.info(
      `[scenario C] C1 pool busy ≤ ${pool.maxBusy} (active ≤ ${pool.maxActive}, ` +
        `idle in tx ≤ ${pool.maxIdleInTransaction}), open ≤ ${pool.maxOpen}, at max in ` +
        `${pool.samplesAtMax}/${pool.samples} samples; p95 ${percentile(
          outcomes.map((o) => o.ms),
          95,
        )} ms (pool asserted: ${POOL_ASSERTED})`,
    );

    expect(formatServerErrors(scenario.serverErrors)).toBe('');
    expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
    // Exactly one copy recorded the result; every other copy found it already recorded.
    expect(bodiesOf(outcomes).filter((b) => b.RspCode === '00')).toEqual([OK]);
    expect(bodiesOf(outcomes).filter((b) => b.RspCode === '02')).toHaveLength(DUPLICATES - 1);

    // The state, not the answers: sold once, confirmed once, one ticket per seat, one event.
    expect(state.booking.status).toBe('CONFIRMED');
    expect(state.booking.confirmedAt).not.toBeNull();
    expect(state.payments).toEqual([
      expect.objectContaining({ status: 'SUCCESS', vnpTransactionNo: query.vnp_TransactionNo }),
    ]);
    expect(state.seats).toEqual(
      paid.seatIds.map((seatId) => ({
        seatId,
        status: 'SOLD',
        bookingId: paid.booking.id,
        heldUntil: null,
      })),
    );
    expect(state.tickets).toEqual(paid.seatIds.map((seatId) => ({ seatId, status: 'ISSUED' })));
    expect(state.events).toEqual(['booking.confirmed']);
    expect(found).toEqual([]);

    if (POOL_ASSERTED) {
      // Some connection was always free: a burst of retries never exhausts the pool. See
      // POOL_ASSERTED above for why this is accepted on Linux only.
      expect(pool.samples).toBeGreaterThan(0);
      expect(pool.maxOpen).toBeLessThanOrEqual(SCENARIO_POOL_MAX);
      expect(pool.maxBusy).toBeLessThan(SCENARIO_POOL_MAX);
    }
  }, 120_000);

  // ─── C2: a forged IPN ───

  it(`2 — ${FORGERIES} forged IPNs at once: all 97, nothing changes`, async () => {
    const showtime = await scenario.showtime(room.id);
    const paid = await bookAndPay(showtime.id, ['B1', 'B2']);
    const before = await stateOf(paid);
    const queries = [
      // Signed with somebody else's secret.
      ...Array.from({ length: FORGERIES - 2 }, () => ipnQuery(paid, {}, 'another-secret')),
      // A failure dressed up as a success: the code was changed after signing.
      { ...ipnQuery(paid, { vnp_ResponseCode: '24' }), vnp_ResponseCode: '00' },
      // The amount was raised after signing.
      { ...ipnQuery(paid), vnp_Amount: String(paid.booking.total * 100 * 2) },
    ];
    scenario.serverErrors.splice(0);

    const { outcomes, ms } = await burst(queries);

    const state = await stateOf(paid);
    const found = await violationsNow();
    record({
      name: 'C2 invalid signature',
      requests: queries.length,
      ms,
      answers: tallyIpn(outcomes),
      bookingStatus: state.booking.status,
      tickets: state.tickets.length,
      outbox: state.events,
      violations: found,
    });

    expect(formatServerErrors(scenario.serverErrors)).toBe('');
    expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
    expect(bodiesOf(outcomes)).toEqual(queries.map(() => BAD_SIGNATURE));
    // Byte for byte what it was: the payment is still PENDING and the seats still held.
    expect(state).toEqual(before);
    expect(state.booking.status).toBe('PENDING');
    expect(state.payments).toEqual([
      expect.objectContaining({ status: 'PENDING', vnpTransactionNo: null, processedAt: null }),
    ]);
    expect(state.events).toEqual([]);
    expect(found).toEqual([]);
  }, 120_000);

  // ─── C3: the wrong amount ───

  it('3 — a correctly signed IPN with the wrong amount: 04, nothing changes', async () => {
    const showtime = await scenario.showtime(room.id);
    const paid = await bookAndPay(showtime.id, ['C1', 'C2']);
    const before = await stateOf(paid);
    const total = paid.booking.total;
    const queries = [
      // In dong instead of × 100 — the mistake a merchant makes.
      ipnQuery(paid, { vnp_Amount: String(total) }),
      // One dong short, and one dong over.
      ipnQuery(paid, { vnp_Amount: String(total * 100 - 100) }),
      ipnQuery(paid, { vnp_Amount: String(total * 100 + 100) }),
      // Right value, wrong shape: a leading zero and a decimal point.
      ipnQuery(paid, { vnp_Amount: `0${total * 100}` }),
      ipnQuery(paid, { vnp_Amount: `${total * 100}.00` }),
    ];
    scenario.serverErrors.splice(0);

    const { outcomes, ms } = await burst(queries);

    const state = await stateOf(paid);
    const found = await violationsNow();
    record({
      name: 'C3 invalid amount',
      requests: queries.length,
      ms,
      answers: tallyIpn(outcomes),
      bookingStatus: state.booking.status,
      tickets: state.tickets.length,
      outbox: state.events,
      violations: found,
    });

    expect(formatServerErrors(scenario.serverErrors)).toBe('');
    expect(bodiesOf(outcomes)).toEqual(queries.map(() => BAD_AMOUNT));
    expect(state).toEqual(before);
    expect(state.booking.status).toBe('PENDING');
    expect(state.events).toEqual([]);
    expect(found).toEqual([]);

    // And the right amount, on the same payment, still goes through: `04` left nothing behind.
    const accepted = await burst([ipnQuery(paid)]);
    expect(bodiesOf(accepted.outcomes)).toEqual([OK]);
    const settled = await stateOf(paid);
    expect(settled.booking.status).toBe('CONFIRMED');
    expect(settled.tickets).toHaveLength(paid.seatIds.length);
    expect(await violationsNow()).toEqual([]);
  }, 120_000);

  // ─── C4: an IPN inside the payment grace period ───

  it('4 — an IPN after expiresAt but before holdUntil: still confirmed, seats never released', async () => {
    const showtime = await scenario.showtime(room.id);
    const paid = await bookAndPay(showtime.id, ['D1', 'D2']);
    // Past expiresAt (no new payment could start now) but inside the grace: the seats are still
    // HELD for this booking, so the IPN takes branch A — this is what the grace period is for.
    scenario.clock.advance({ minutes: HOLD_TTL_MINUTES + 1 });
    const beforeIpn = await stateOf(paid);
    expect(beforeIpn.booking.status).toBe('PENDING');
    expect(beforeIpn.seats.map((seat) => seat.status)).toEqual(paid.seatIds.map(() => 'HELD'));
    // The expiry agrees it is too soon, and changes nothing.
    await expect(worker.expiry.expire(paid.booking.id)).resolves.toEqual(
      expect.objectContaining<Partial<ExpireOutcome>>({ outcome: 'early' }),
    );
    scenario.serverErrors.splice(0);

    const { outcomes, ms } = await burst([ipnQuery(paid)]);

    const state = await stateOf(paid);
    const found = await violationsNow();
    record({
      name: 'C4 IPN inside the grace period',
      requests: 1,
      ms,
      answers: tallyIpn(outcomes),
      bookingStatus: state.booking.status,
      tickets: state.tickets.length,
      outbox: state.events,
      violations: found,
    });

    expect(formatServerErrors(scenario.serverErrors)).toBe('');
    expect(bodiesOf(outcomes)).toEqual([OK]);
    expect(state.booking.status).toBe('CONFIRMED');
    expect(state.seats).toEqual(
      paid.seatIds.map((seatId) => ({
        seatId,
        status: 'SOLD',
        bookingId: paid.booking.id,
        heldUntil: null,
      })),
    );
    expect(state.tickets).toEqual(paid.seatIds.map((seatId) => ({ seatId, status: 'ISSUED' })));
    // Branch A, not B: the booking never expired, so no seat was ever given back.
    expect(state.events).toEqual(['booking.confirmed']);
    expect(found).toEqual([]);

    // The expiry afterwards is a no-op: the booking is no longer PENDING.
    scenario.clock.advance({ minutes: PAYMENT_GRACE_MINUTES });
    await expect(worker.expiry.expire(paid.booking.id)).resolves.toEqual({ outcome: 'noop' });
    expect(await violationsNow()).toEqual([]);
  }, 120_000);

  // ─── C5: an IPN after the seat went to somebody else ───

  it('5 — an IPN after the seat was sold to another booking: NEEDS_REVIEW, no ticket', async () => {
    const showtime = await scenario.showtime(room.id);
    const late = await bookAndPay(showtime.id, ['A5', 'A6']);
    // The hold runs out. Lazy expiry makes the seats free for the next customer before any job ran.
    scenario.clock.advance({ minutes: HOLD_MINUTES });
    const winner = await bookAndPay(showtime.id, ['A5']);
    expect(bodiesOf((await burst([ipnQuery(winner)])).outcomes)).toEqual([OK]);
    const winnerBefore = await stateOf(winner);
    expect(winnerBefore.booking.status).toBe('CONFIRMED');
    scenario.serverErrors.splice(0);

    // Now the money of the first customer arrives (VNPay retries for up to ~45 minutes).
    const { outcomes, ms } = await burst([ipnQuery(late)]);

    const state = await stateOf(late);
    const found = await violationsNow();
    record({
      name: 'C5 IPN after the seat was sold',
      requests: 1,
      ms,
      answers: tallyIpn(outcomes),
      bookingStatus: state.booking.status,
      tickets: state.tickets.length,
      outbox: state.events,
      violations: found,
    });

    expect(formatServerErrors(scenario.serverErrors)).toBe('');
    // VNPay is told the result was recorded: the money is ours and the case is now an admin's.
    expect(bodiesOf(outcomes)).toEqual([OK]);
    expect(state.booking.status).toBe('NEEDS_REVIEW');
    expect(state.payments).toEqual([expect.objectContaining({ status: 'SUCCESS' })]);
    expect(state.tickets).toEqual([]);
    // A5 belongs to the winner and is left alone; A6, held by this booking, goes back at once.
    expect(state.seats).toEqual([
      { seatId: room.seat('A5'), status: 'SOLD', bookingId: winner.booking.id, heldUntil: null },
      { seatId: room.seat('A6'), status: 'AVAILABLE', bookingId: null, heldUntil: null },
    ]);
    expect(state.events).toEqual(['booking.needs_review', 'seats.released']);
    // Nothing of the winner's moved.
    expect(await stateOf(winner)).toEqual(winnerBefore);
    expect(found).toEqual([]);

    // A repeated IPN of the same payment changes nothing and answers 02.
    const again = await burst([ipnQuery(late)]);
    expect(bodiesOf(again.outcomes)).toEqual([ALREADY]);
    expect(await stateOf(late)).toEqual(state);
    expect(await violationsNow()).toEqual([]);
  }, 120_000);

  // ─── C6: an IPN racing the expiry job ───

  describe(`6 — an IPN racing the expiry job, ${RACE_ROUNDS} rounds`, () => {
    /** What the expiry answered in each round: the proof that both orders really happened. */
    const expiryOutcomes: string[] = [];

    for (let round = 1; round <= RACE_ROUNDS; round++) {
      it(`round ${round}/${RACE_ROUNDS} (seed ${SEED + round}): the booking is never half-settled`, async () => {
        const next = random(SEED + round);
        const showtime = await scenario.showtime(room.id);
        const paid = await bookAndPay(showtime.id, ['B5', 'B6']);
        // Past holdUntil: the expiry would take the seats back, and the IPN is on its way.
        scenario.clock.advance({ minutes: HOLD_MINUTES });
        const query = ipnQuery(paid);
        // Even rounds let the expiry go first, odd rounds the IPN; the jitter still decides the
        // real order within a few tens of milliseconds, so both are genuine races.
        const expiryFirst = round % 2 === 0;
        const ipnDelay =
          (expiryFirst ? RACE_HEAD_START_MS : 0) + Math.floor(next() * RACE_MAX_DELAY_MS);
        const expiryDelay =
          (expiryFirst ? 0 : RACE_HEAD_START_MS) + Math.floor(next() * RACE_MAX_DELAY_MS);
        scenario.serverErrors.splice(0);

        const client = ipnClient(scenario.baseUrl, 4);
        const started = performance.now();
        const [ipn, expiry] = await Promise.all([
          pause(ipnDelay).then(() => client.send(query)),
          runExpiry(paid.booking.id, expiryDelay),
        ]);
        const ms = Math.round(performance.now() - started);
        client.destroy();

        expiryOutcomes.push(expiry.outcome);
        const state = await stateOf(paid);
        const found = await violationsNow();
        record({
          name: `C6 race round ${round}`,
          requests: 1,
          ms,
          answers: {
            ...tallyIpn([ipn]),
            [`expiry ${expiry.outcome}`]: 1,
          },
          bookingStatus: state.booking.status,
          tickets: state.tickets.length,
          outbox: state.events,
          violations: found,
        });

        expect(formatServerErrors(scenario.serverErrors)).toBe('');
        expect(ipn.status).toBe(200);
        // The expiry must never fail: a busy booking comes back `skipped`, never an exception.
        expect(expiry.outcome).not.toBe('threw');
        // The IPN always records the money, whichever side ran first.
        expect(bodiesOf([ipn])).toEqual([OK]);
        expect(state.payments).toEqual([expect.objectContaining({ status: 'SUCCESS' })]);

        // Two endings are correct, and nothing in between: the seats were still there (the IPN
        // got the row first, or the expiry had given them back and branch B took them again), or
        // they were not and the booking is an admin's problem.
        if (state.booking.status === 'CONFIRMED') {
          expect(state.seats).toEqual(
            paid.seatIds.map((seatId) => ({
              seatId,
              status: 'SOLD',
              bookingId: paid.booking.id,
              heldUntil: null,
            })),
          );
          expect(state.tickets).toEqual(
            paid.seatIds.map((seatId) => ({ seatId, status: 'ISSUED' })),
          );
          expect(state.events).toContain('booking.confirmed');
          expect(state.events).not.toContain('booking.needs_review');
        } else {
          expect(state.booking.status).toBe('NEEDS_REVIEW');
          expect(state.tickets).toEqual([]);
          // A booking under review keeps no seat of its own.
          expect(state.seats.filter((seat) => seat.bookingId === paid.booking.id)).toEqual([]);
          expect(state.events).toContain('booking.needs_review');
        }
        expect(found).toEqual([]);
      }, 60_000);
    }

    // Without this the rounds above could all have run in the same order and still pass, which
    // would make the race vacuous. Needs enough rounds for both halves to have run.
    (RACE_ROUNDS >= 4 ? it : it.skip)('raced in both orders', () => {
      const counts = expiryOutcomes.reduce<Record<string, number>>((acc, outcome) => {
        acc[outcome] = (acc[outcome] ?? 0) + 1;
        return acc;
      }, {});
      console.info(
        `[scenario C] C6 expiry outcomes over ${RACE_ROUNDS} rounds: ${JSON.stringify(counts)}`,
      );

      expect(expiryOutcomes).toHaveLength(RACE_ROUNDS);
      // The IPN got there first (the booking was no longer PENDING, or its row was held).
      expect(expiryOutcomes.filter((o) => o === 'noop' || o === 'skipped').length).toBeGreaterThan(
        0,
      );
      // And the expiry got there first at least once, so branch B was really exercised.
      expect(expiryOutcomes.filter((o) => o === 'expired').length).toBeGreaterThan(0);
      expect(expiryOutcomes.filter((o) => o === 'threw')).toEqual([]);
    });
  });
});
