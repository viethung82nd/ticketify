import { createHmac } from 'node:crypto';
import {
  newRequestId,
  QUERYDR,
  QUERYDR_IP_ADDR,
  QuerydrVerdict,
  querydrBody,
  querydrResponseHashData,
  readQuerydrAnswer,
  verifyQuerydrResponse,
} from './vnpay-querydr';

/** Test-only merchant secret; never a real one. */
const SECRET = 'unit-test-vnpay-hash-secret';
const TMN_CODE = 'TKFTEST1';
const TXN_REF = 'Bq2qmIzmEDBQ2nWyKR55';
const REQUEST_ID = '0123456789abcdef0123456789abcdef';

const hmac = (data: string): string =>
  createHmac('sha512', SECRET).update(data, 'utf8').digest('hex');

const request = {
  tmnCode: TMN_CODE,
  txnRef: TXN_REF,
  transactionDate: '20261101170000',
  createDate: '20261101171500',
  orderInfo: 'Truy van thanh toan ve K7PX3MQ9TA',
};

/** A querydr response, signed unless told otherwise. */
function response(
  overrides: Record<string, string | undefined> = {},
  secret = SECRET,
): Record<string, string> {
  const body: Record<string, string> = {
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
    vnp_OrderInfo: request.orderInfo,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete body[key];
    else body[key] = value;
  }
  return {
    ...body,
    vnp_SecureHash: createHmac('sha512', secret)
      .update(querydrResponseHashData(body), 'utf8')
      .digest('hex'),
  };
}

describe('querydrBody — the signed request', () => {
  it('sends the documented parameters and nothing else', () => {
    const body = querydrBody(request, SECRET, REQUEST_ID);

    expect(Object.keys(body).sort()).toEqual([
      'vnp_Command',
      'vnp_CreateDate',
      'vnp_IpAddr',
      'vnp_OrderInfo',
      'vnp_RequestId',
      'vnp_SecureHash',
      'vnp_TmnCode',
      'vnp_TransactionDate',
      'vnp_TxnRef',
      'vnp_Version',
    ]);
    expect(body.vnp_Version).toBe(QUERYDR.version);
    expect(body.vnp_Command).toBe(QUERYDR.command);
    expect(body.vnp_IpAddr).toBe(QUERYDR_IP_ADDR);
    // vnp_TransactionNo is optional and left out of the hash by the documentation: never sent.
    expect(body.vnp_TransactionNo).toBeUndefined();
  });

  it('signs the documented `|`-joined order, not the sorted query string', () => {
    const body = querydrBody(request, SECRET, REQUEST_ID);

    const data = [
      REQUEST_ID,
      QUERYDR.version,
      QUERYDR.command,
      TMN_CODE,
      TXN_REF,
      request.transactionDate,
      request.createDate,
      QUERYDR_IP_ADDR,
      request.orderInfo,
    ].join('|');
    expect(body.vnp_SecureHash).toBe(hmac(data));
    // The payment URL's own encoding (sorted, urlencoded, spaces as `+`) would be another hash.
    expect(body.vnp_SecureHash).not.toBe(
      hmac(`vnp_Command=querydr&vnp_CreateDate=${request.createDate}`),
    );
  });

  it('draws a 32-character alphanumeric vnp_RequestId by default', () => {
    const first = querydrBody(request, SECRET).vnp_RequestId;
    const second = querydrBody(request, SECRET).vnp_RequestId;

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    expect(newRequestId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('verifyQuerydrResponse', () => {
  it('accepts a response signed with the merchant secret', () => {
    expect(verifyQuerydrResponse(response(), SECRET)).toBe(true);
  });

  it('accepts an upper-case hex signature', () => {
    const body = response();
    expect(
      verifyQuerydrResponse(
        { ...body, vnp_SecureHash: body.vnp_SecureHash!.toUpperCase() },
        SECRET,
      ),
    ).toBe(true);
  });

  it.each([
    ['another secret', () => response({}, 'another-secret')],
    ['a changed field after signing', () => ({ ...response(), vnp_Amount: '1' })],
    [
      'no signature at all',
      () => {
        const { vnp_SecureHash: _hash, ...rest } = response();
        return rest;
      },
    ],
    ['an empty signature', () => ({ ...response(), vnp_SecureHash: '' })],
    ['a signature of the wrong length', () => ({ ...response(), vnp_SecureHash: 'ab' })],
  ])('refuses %s', (_label, build) => {
    expect(verifyQuerydrResponse(build() as Record<string, unknown>, SECRET)).toBe(false);
  });

  it('joins every documented field with `|`, empty for an absent optional one', () => {
    const data = querydrResponseHashData(response({ vnp_PayDate: undefined }));

    expect(data.split('|')).toHaveLength(15);
    // vnp_ResponseId|vnp_Command|vnp_ResponseCode|vnp_Message|vnp_TmnCode|vnp_TxnRef|vnp_Amount|
    // vnp_BankCode|vnp_PayDate|…: the 9th field is the missing vnp_PayDate.
    expect(data.split('|')[8]).toBe('');
    // vnp_PromotionCode and vnp_PromotionAmount, absent here, are the last two.
    expect(data.endsWith('||')).toBe(true);
  });
});

describe('readQuerydrAnswer', () => {
  const read = (body: Record<string, unknown>) => readQuerydrAnswer(body, TXN_REF, SECRET);

  it('paid: the query succeeded and the payment went through', () => {
    const answer = read(response());

    expect(answer.verdict).toBe(QuerydrVerdict.PAID);
    expect(answer.responseCode).toBe('00');
    expect(answer.transactionStatus).toBe('00');
    expect(answer.params.vnp_TransactionNo).toBe('14226112');
    // The response is kept as received, to be stored as raw_payload.
    expect(answer.params.vnp_Amount).toBe('18000000');
  });

  it('not_paid: vnp_ResponseCode 91, VNPay has no such transaction', () => {
    const answer = read(response({ vnp_ResponseCode: '91', vnp_TransactionStatus: '' }));

    expect(answer.verdict).toBe(QuerydrVerdict.NOT_PAID);
    expect(answer.reason).toMatch(/no such transaction/);
  });

  it.each([
    ['02 the payment failed', '02'],
    ['09 the refund was refused', '09'],
  ])('not_paid: vnp_TransactionStatus %s', (_label, status) => {
    expect(read(response({ vnp_TransactionStatus: status })).verdict).toBe(QuerydrVerdict.NOT_PAID);
  });

  it.each([
    ['01 not complete', '01'],
    ['04 reversed at the bank', '04'],
    ['05 refund being processed', '05'],
    ['06 refund sent to the bank', '06'],
    ['07 suspected fraud', '07'],
    ['a status VNPay does not document', '42'],
  ])('unknown: vnp_TransactionStatus %s is not settled', (_label, status) => {
    const answer = read(response({ vnp_TransactionStatus: status }));

    expect(answer.verdict).toBe(QuerydrVerdict.UNKNOWN);
    expect(answer.reason).toMatch(/not settled/);
  });

  it.each([
    ['02 bad TmnCode', '02'],
    ['03 bad format', '03'],
    ['94 duplicate request', '94'],
    ['97 bad checksum', '97'],
    ['99 other error', '99'],
  ])('unknown: the query itself failed with vnp_ResponseCode %s', (_label, code) => {
    const answer = read(response({ vnp_ResponseCode: code }));

    expect(answer.verdict).toBe(QuerydrVerdict.UNKNOWN);
    expect(answer.reason).toMatch(/the query itself failed/);
  });

  it('unknown: a response this secret cannot verify is never read as paid', () => {
    const answer = read(response({}, 'another-secret'));

    expect(answer.verdict).toBe(QuerydrVerdict.UNKNOWN);
    expect(answer.reason).toMatch(/signature does not match/);
  });

  it('unknown: a signed response about another payment', () => {
    const other = 'ZZZZZZZZZZZZZZZZZZZZ';
    const answer = read(response({ vnp_TxnRef: other }));

    expect(answer.verdict).toBe(QuerydrVerdict.UNKNOWN);
    expect(answer.reason).toContain(other);
  });

  it('unknown: an empty body', () => {
    expect(read({}).verdict).toBe(QuerydrVerdict.UNKNOWN);
  });

  it('keeps only string values in params', () => {
    const body = { ...response(), vnp_Extra: 7, vnp_Nested: { a: 1 } };

    expect(read(body).params.vnp_Extra).toBeUndefined();
    expect(read(body).params.vnp_Nested).toBeUndefined();
  });

  it('never puts the hash secret in the reason', () => {
    for (const code of ['00', '91', '97', '99']) {
      expect(read(response({ vnp_ResponseCode: code })).reason).not.toContain(SECRET);
    }
  });
});
