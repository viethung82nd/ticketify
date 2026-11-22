import {
  MOMO_PENDING_CODES,
  MomoResultState,
  momoResultState,
  readMomoReport,
  readMomoResultFields,
} from './momo-result';
import { momoSample } from './testing/momo-sample';

const ipn = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...momoSample.cases.ipnSuccess.fields,
  signature: momoSample.cases.ipnSuccess.signature,
  ...overrides,
});

describe('momoResultState', () => {
  it('0 is paid', () => {
    expect(momoResultState(0)).toBe(MomoResultState.PAID);
  });

  it.each([...MOMO_PENDING_CODES])('%i is not final: pending', (code) => {
    expect(momoResultState(code)).toBe(MomoResultState.PENDING);
  });

  it.each([1001, 1004, 1005, 1006, 1017, 1026, 4001, 4100, 11, 13, 21, 99])(
    '%i is a final failure',
    (code) => {
      expect(momoResultState(code)).toBe(MomoResultState.FAILED);
    },
  );
});

describe('readMomoResultFields', () => {
  it('types the IPN body (JSON numbers) and the redirect query (strings) alike', () => {
    const fromBody = readMomoResultFields(ipn());
    const fromQuery = readMomoResultFields(
      Object.fromEntries(Object.entries(ipn()).map(([key, value]) => [key, String(value)])),
    );

    expect(fromBody).toEqual({
      partnerCode: 'MOMOTKF20261122',
      orderId: 'Bq2qmIzmEDBQ2nWyKR55',
      requestId: '5f0c6d1e9a8b4c3d2e1f0a9b8c7d6e5f',
      amount: 180_000,
      resultCode: 0,
      transId: '4088878653',
      message: 'Successful.',
      payType: 'qr',
    });
    expect(fromQuery).toEqual(fromBody);
  });

  it.each([
    ['orderId missing', { orderId: undefined }],
    ['orderId empty', { orderId: '' }],
    ['orderId a number', { orderId: 42 }],
    ['requestId missing', { requestId: undefined }],
    ['partnerCode missing', { partnerCode: undefined }],
    ['amount missing', { amount: undefined }],
    ['amount a fraction', { amount: 1.5 }],
    ['amount text with letters', { amount: '18e4' }],
    ['resultCode missing', { resultCode: undefined }],
    ['resultCode text', { resultCode: 'zero' }],
    ['transId missing', { transId: undefined }],
    ['message missing', { message: undefined }],
    ['payType null', { payType: null }],
  ])('malformed (%s): null', (_label, overrides) => {
    expect(readMomoResultFields(ipn(overrides))).toBeNull();
  });
});

describe('readMomoReport', () => {
  it('paid: amount in dong, resultCode and transId as text, the whole body as raw', () => {
    const body = ipn();
    const fields = readMomoResultFields(body)!;

    expect(readMomoReport(fields, body)).toEqual({
      amount: '180000',
      paid: true,
      responseCode: '0',
      transactionStatus: null,
      bankCode: null,
      transactionNo: '4088878653',
      raw: body,
    });
  });

  it('failed: not paid, resultCode kept', () => {
    const body = ipn({ resultCode: 1006 });
    const report = readMomoReport(readMomoResultFields(body)!, body);

    expect(report).toMatchObject({ paid: false, responseCode: '1006' });
  });

  it.each([0, -1])('transId %i names no transaction: not kept', (transId) => {
    const body = ipn({ transId, resultCode: 1006 });
    expect(readMomoReport(readMomoResultFields(body)!, body).transactionNo).toBeNull();
  });
});
