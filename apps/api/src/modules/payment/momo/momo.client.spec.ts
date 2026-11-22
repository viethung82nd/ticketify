import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../../config/app-config.service';
import type { Env } from '../../../config/env.schema';
import {
  MOMO_PATHS,
  MomoClient,
  type MomoCreateInput,
  type MomoCreateSettings,
  MomoQueryVerdict,
} from './momo.client';
import { verifyMomoSignature } from './momo-signature';
import { momoSample } from './testing/momo-sample';

/** Test-only merchant settings (the fixture's); never real ones. */
const { partnerCode, accessKey, secretKey } = momoSample.credentials;
const ENDPOINT = 'https://test-payment.momo.vn';
const ORDER_ID = 'Bq2qmIzmEDBQ2nWyKR55';
const REQUEST_ID = '5f0c6d1e9a8b4c3d2e1f0a9b8c7d6e5f';
const PAY_URL = 'https://test-payment.momo.vn/v2/gateway/pay?t=TU9NT3xCcTJxbUl6bUVEQlE';

type Overrides = Partial<Record<keyof Env, unknown>>;

function clientWith(overrides: Overrides = {}): MomoClient {
  const values: Overrides = {
    MOMO_PARTNER_CODE: partnerCode,
    MOMO_ACCESS_KEY: accessKey,
    MOMO_SECRET_KEY: secretKey,
    MOMO_ENDPOINT: ENDPOINT,
    MOMO_REDIRECT_URL: 'http://localhost:5173/payment/result/momo',
    MOMO_IPN_URL: 'https://api.example.test/payments/momo/ipn',
    MOMO_REQUEST_TIMEOUT_MS: 30_000,
    MOMO_QUERY_TIMEOUT_MS: 5_000,
    ...overrides,
  };
  const config = { get: (key: keyof Env) => values[key] } as unknown as AppConfig;
  return new MomoClient(config);
}

const input: MomoCreateInput = {
  orderId: ORDER_ID,
  requestId: REQUEST_ID,
  amount: 180_000,
  orderInfo: 'Thanh toan ve K7PX3MQ9TA',
};

const settingsOf = (client: MomoClient): MomoCreateSettings => {
  const settings = client.createSettings();
  if (!settings) throw new Error('test client is not configured');
  return settings;
};

/** A create answer as MoMo's documentation shows it. */
const createdBody = (overrides: Record<string, unknown> = {}) => ({
  partnerCode,
  orderId: ORDER_ID,
  requestId: REQUEST_ID,
  amount: 180_000,
  responseTime: 1_793_534_700_000,
  message: 'Thành công.',
  resultCode: 0,
  payUrl: PAY_URL,
  deeplink: 'momo://app?action=payWithApp',
  qrCodeUrl: '2|99|2|qr',
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let fetchMock: jest.SpiedFunction<typeof fetch>;
let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** The JSON body of the n-th fetch call. */
const sentBody = (n = 0): Record<string, unknown> => {
  const body = fetchMock.mock.calls[n]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('fetch was not called with a JSON string body');
  return JSON.parse(body) as Record<string, unknown>;
};

/** Every log line written, to check nothing secret reaches it. */
const logged = () =>
  [warn, error].flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join('\n');

describe('MomoClient — configuration', () => {
  it.each(['MOMO_PARTNER_CODE', 'MOMO_ACCESS_KEY', 'MOMO_SECRET_KEY'] as const)(
    'missing %s: no merchant, no create settings, not configured',
    (key) => {
      const client = clientWith({ [key]: undefined });
      expect(client.merchant()).toBeNull();
      expect(client.createSettings()).toBeNull();
      expect(client.configured).toBe(false);
    },
  );

  it.each(['MOMO_REDIRECT_URL', 'MOMO_IPN_URL'] as const)(
    'missing %s: the IPN can be verified, but no payment can be created',
    (key) => {
      const client = clientWith({ [key]: undefined });
      expect(client.merchant()).not.toBeNull();
      expect(client.createSettings()).toBeNull();
    },
  );
});

describe('MomoClient.create', () => {
  it('POSTs the documented JSON body to /v2/gateway/api/create, signed as the reference', async () => {
    fetchMock.mockResolvedValue(jsonResponse(createdBody()));
    const client = clientWith();

    await client.create(settingsOf(client), input);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ENDPOINT}${MOMO_PATHS.create}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json; charset=UTF-8' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = sentBody();
    expect(body).toEqual({
      ...momoSample.cases.create.fields,
      lang: 'vi',
      signature: momoSample.cases.create.signature,
    });
    // Never sent: the keys themselves.
    expect(JSON.stringify(body)).not.toContain(secretKey);
    expect(body).not.toHaveProperty('accessKey');
  });

  it('resultCode 0 for exactly this order: created, with the payUrl', async () => {
    fetchMock.mockResolvedValue(jsonResponse(createdBody()));
    const client = clientWith();

    await expect(client.create(settingsOf(client), input)).resolves.toEqual({
      kind: 'created',
      payUrl: PAY_URL,
      resultCode: 0,
    });
  });

  it.each([
    ['another orderId', { orderId: 'ZZZZZZZZZZZZZZZZZZZZ' }],
    ['another requestId', { requestId: 'ffffffffffffffffffffffffffffffff' }],
    ['another partnerCode', { partnerCode: 'MOMOOTHER' }],
    ['another amount', { amount: 1_000 }],
    ['no payUrl', { payUrl: undefined }],
    ['a payUrl that is not a URL', { payUrl: 'not a url' }],
    ['a javascript: payUrl', { payUrl: 'javascript:alert(1)' }],
  ])('malformed success (%s): unavailable, nothing to hand out', async (_label, overrides) => {
    fetchMock.mockResolvedValue(jsonResponse(createdBody(overrides)));
    const client = clientWith();

    await expect(client.create(settingsOf(client), input)).resolves.toMatchObject({
      kind: 'unavailable',
      timedOut: false,
    });
  });

  it.each([
    [21, 'Số tiền giao dịch không hợp lệ.', 400],
    [13, 'Xác thực doanh nghiệp thất bại.', 200],
    [41, 'Trùng orderId.', 200],
  ])(
    'final error %i: refused, signature removed from the kept body',
    async (code, message, status) => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          createdBody({ resultCode: code, message, payUrl: undefined, signature: 'ab'.repeat(32) }),
          status,
        ),
      );
      const client = clientWith();

      const answer = await client.create(settingsOf(client), input);
      expect(answer).toMatchObject({ kind: 'refused', resultCode: code, message });
      expect(answer.kind === 'refused' && answer.body).not.toHaveProperty('signature');
    },
  );

  it('7000 with HTTP 422 (same requestId still in progress): unavailable, not refused', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(createdBody({ resultCode: 7000, payUrl: undefined }), 422),
    );
    const client = clientWith();

    await expect(client.create(settingsOf(client), input)).resolves.toMatchObject({
      kind: 'unavailable',
      timedOut: false,
    });
  });

  it('timeout: unavailable, timedOut (the request may have been accepted)', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const client = clientWith();

    await expect(client.create(settingsOf(client), input)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'timed out after 30000 ms',
      timedOut: true,
    });
  });

  it('the timeout given to fetch is MOMO_REQUEST_TIMEOUT_MS', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(jsonResponse(createdBody()));
    const client = clientWith({ MOMO_REQUEST_TIMEOUT_MS: 12_345 });

    await client.create(settingsOf(client), input);
    expect(timeout).toHaveBeenCalledWith(12_345);
  });

  it.each([
    ['network error', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    [
      'HTML error page',
      () => fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 })),
    ],
    [
      'JSON without resultCode',
      () => fetchMock.mockResolvedValue(jsonResponse({ error: 'x' }, 500)),
    ],
    ['JSON array', () => fetchMock.mockResolvedValue(jsonResponse([1, 2]))],
  ])('%s: unavailable, never throws', async (_label, arrange) => {
    arrange();
    const client = clientWith();

    await expect(client.create(settingsOf(client), input)).resolves.toMatchObject({
      kind: 'unavailable',
      timedOut: false,
    });
  });

  it('never logs a key or a signature', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(createdBody({ resultCode: 21, signature: 'cd'.repeat(32) })),
    );
    const client = clientWith();

    await client.create(settingsOf(client), input);
    const lines = logged();
    expect(lines).toContain(ORDER_ID);
    expect(lines).not.toContain(secretKey);
    expect(lines).not.toContain(accessKey);
    expect(lines).not.toContain(momoSample.cases.create.signature);
    expect(lines).not.toContain('cd'.repeat(32));
  });
});

describe('MomoClient.query', () => {
  /** A query answer to the request just sent (same requestId). */
  const answerTo =
    (overrides: Record<string, unknown> = {}) =>
    () => {
      const sent = sentBody();
      return jsonResponse({
        partnerCode,
        orderId: ORDER_ID,
        requestId: sent.requestId,
        extraData: '',
        amount: 180_000,
        transId: 4_088_878_653,
        payType: 'qr',
        resultCode: 0,
        refundTrans: [],
        message: 'Thành công.',
        responseTime: 1_793_534_700_000,
        lastUpdated: 1_793_534_700_000,
        ...overrides,
      });
    };
  const respond = (overrides: Record<string, unknown> = {}) =>
    fetchMock.mockImplementation(() => Promise.resolve(answerTo(overrides)()));

  it('POSTs a signed query to /v2/gateway/api/query with a new requestId', async () => {
    respond();
    await clientWith().query(ORDER_ID);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${ENDPOINT}${MOMO_PATHS.query}`);
    const body = sentBody();
    expect(body).toMatchObject({ partnerCode, orderId: ORDER_ID, lang: 'vi' });
    expect(body.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyMomoSignature('query', body, { accessKey, secretKey })).toBe(true);
  });

  it('resultCode 0 about this order, to this query: PAID with a report', async () => {
    respond();
    const answer = await clientWith().query(ORDER_ID);

    expect(answer.verdict).toBe(MomoQueryVerdict.PAID);
    expect(answer.report).toMatchObject({
      amount: '180000',
      paid: true,
      responseCode: '0',
      transactionNo: '4088878653',
    });
  });

  it.each([1006, 1005, 1017])('final failure %i: NOT_PAID', async (resultCode) => {
    respond({ resultCode });
    await expect(clientWith().query(ORDER_ID)).resolves.toMatchObject({
      verdict: MomoQueryVerdict.NOT_PAID,
      report: null,
    });
  });

  it.each([
    ['still waiting for the user (1000)', { resultCode: 1000 }],
    ['being processed (7000)', { resultCode: 7000 }],
    ['about another order', { orderId: 'ZZZZZZZZZZZZZZZZZZZZ' }],
    ['for another merchant', { partnerCode: 'MOMOOTHER' }],
    ['not to this query (old requestId)', { requestId: 'ffffffffffffffffffffffffffffffff' }],
    ['paid without a transId', { transId: 0 }],
    ['paid without an amount', { amount: undefined }],
  ])('%s: UNKNOWN', async (_label, overrides) => {
    respond(overrides);
    await expect(clientWith().query(ORDER_ID)).resolves.toMatchObject({
      verdict: MomoQueryVerdict.UNKNOWN,
      report: null,
    });
  });

  it('timeout or network error: UNKNOWN, never throws', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(clientWith().query(ORDER_ID)).resolves.toMatchObject({
      verdict: MomoQueryVerdict.UNKNOWN,
    });
  });

  it('not configured: UNKNOWN without any HTTP call', async () => {
    await expect(clientWith({ MOMO_SECRET_KEY: undefined }).query(ORDER_ID)).resolves.toMatchObject(
      {
        verdict: MomoQueryVerdict.UNKNOWN,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
