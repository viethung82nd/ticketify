import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../../config/app-config.service';
import type { Env } from '../../../config/env.schema';
import { FakeClock } from '../../../infra/clock/testing/fake-clock';
import { VnpayQuerydrClient } from './vnpay-querydr.client';
import { QuerydrVerdict, querydrResponseHashData } from './vnpay-querydr';

/** Test-only merchant settings; never real ones. */
const SECRET = 'unit-test-vnpay-hash-secret';
const TMN_CODE = 'TKFTEST1';
const API_URL = 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';
const TXN_REF = 'Bq2qmIzmEDBQ2nWyKR55';
const NOW = new FakeClock('2026-11-01T10:15:00.000Z').now();
const PAID_AT = new FakeClock('2026-11-01T10:00:00.000Z').now();

const lookUp = {
  txnRef: TXN_REF,
  paymentCreatedAt: PAID_AT,
  orderInfo: 'Truy van thanh toan ve K7PX3MQ9TA',
  now: NOW,
};

type Overrides = Partial<Record<keyof Env, unknown>>;

function clientWith(overrides: Overrides = {}): VnpayQuerydrClient {
  const values: Overrides = {
    VNPAY_TMN_CODE: TMN_CODE,
    VNPAY_HASH_SECRET: SECRET,
    VNPAY_API_URL: API_URL,
    VNPAY_QUERYDR_TIMEOUT_MS: 5_000,
    ...overrides,
  };
  const config = { get: (key: keyof Env) => values[key] } as unknown as AppConfig;
  return new VnpayQuerydrClient(config);
}

/** A signed querydr response body. */
function body(overrides: Record<string, string> = {}): Record<string, string> {
  const fields: Record<string, string> = {
    vnp_ResponseId: 'f3c0a2b1d4e5f6a7b8c9d0e1f2a3b4c5',
    vnp_Command: 'querydr',
    vnp_ResponseCode: '00',
    vnp_Message: 'Success',
    vnp_TmnCode: TMN_CODE,
    vnp_TxnRef: TXN_REF,
    vnp_Amount: '18000000',
    vnp_BankCode: 'NCB',
    vnp_PayDate: '20261101170500',
    vnp_TransactionNo: '14226112',
    vnp_TransactionType: '01',
    vnp_TransactionStatus: '00',
    vnp_OrderInfo: lookUp.orderInfo,
    ...overrides,
  };
  return {
    ...fields,
    vnp_SecureHash: createHmac('sha512', SECRET)
      .update(querydrResponseHashData(fields), 'utf8')
      .digest('hex'),
  };
}

/** Replaces `fetch`; the request VNPay would have received is recorded. */
function fakeFetch(answer: () => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(((
    url: string,
    init: RequestInit,
  ) => {
    calls.push({ url, init });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch);
  return { calls, spy };
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('VnpayQuerydrClient', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('posts the signed body as JSON to VNPAY_API_URL', async () => {
    const { calls } = fakeFetch(() => jsonResponse(body()));

    const answer = await clientWith().lookUp(lookUp);

    expect(answer.verdict).toBe(QuerydrVerdict.PAID);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(API_URL);
    expect(calls[0]?.init.method).toBe('POST');
    const raw = calls[0]?.init.body;
    expect(typeof raw).toBe('string');
    const sent = JSON.parse(typeof raw === 'string' ? raw : '{}') as Record<string, string>;
    expect(sent.vnp_Command).toBe('querydr');
    expect(sent.vnp_TxnRef).toBe(TXN_REF);
    // vnp_TransactionDate is the payment's own vnp_CreateDate, in GMT+7.
    expect(sent.vnp_TransactionDate).toBe('20261101170000');
    expect(sent.vnp_CreateDate).toBe('20261101171500');
    expect(sent.vnp_SecureHash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('is not configured, and asks nothing, without the merchant settings', async () => {
    const { calls } = fakeFetch(() => jsonResponse(body()));
    const client = clientWith({ VNPAY_HASH_SECRET: undefined });

    expect(client.configured).toBe(false);
    const answer = await client.lookUp(lookUp);

    expect(answer.verdict).toBe(QuerydrVerdict.UNKNOWN);
    expect(answer.reason).toMatch(/VNPAY_TMN_CODE or VNPAY_HASH_SECRET is not set/);
    expect(calls).toEqual([]);
  });

  it('reports not_paid when VNPay has no such transaction', async () => {
    fakeFetch(() => jsonResponse(body({ vnp_ResponseCode: '91' })));

    expect((await clientWith().lookUp(lookUp)).verdict).toBe(QuerydrVerdict.NOT_PAID);
  });

  it.each<[string, () => Promise<Response> | Response, RegExp]>([
    [
      'a network error',
      () => Promise.reject(new TypeError('fetch failed')),
      /could not be reached: fetch failed/,
    ],
    [
      'a timeout',
      () =>
        Promise.reject(
          Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
        ),
      /could not be reached: The operation was aborted/,
    ],
    ['HTTP 502', () => new Response('<html>bad gateway</html>', { status: 502 }), /HTTP 502/],
    [
      'a body that is not JSON',
      () => new Response('not json', { status: 200 }),
      /could not be reached/,
    ],
    ['a JSON array', () => jsonResponse([1, 2, 3]), /not a JSON object/],
    ['JSON null', () => jsonResponse(null), /not a JSON object/],
  ])(
    'never throws on %s: unknown, so the caller expires as usual',
    async (_label, answer, reason) => {
      fakeFetch(answer);

      const result = await clientWith().lookUp(lookUp);

      expect(result.verdict).toBe(QuerydrVerdict.UNKNOWN);
      expect(result.reason).toMatch(reason);
      expect(result.params).toEqual({});
    },
  );

  it('never leaks the hash secret into the logged reason', async () => {
    fakeFetch(() => jsonResponse(body()));
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const log = jest.spyOn(Logger.prototype, 'log');

    await clientWith().lookUp(lookUp);

    for (const call of [...warn.mock.calls, ...log.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
    }
  });
});
