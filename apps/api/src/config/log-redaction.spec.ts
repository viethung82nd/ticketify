import { redactQuery, redactRequest, redactUrl } from './log-redaction';

const HASH = 'b6dababca5e07a2d8e32fdd3cf05c29cb426c721ae18e9589f7ad0e2db4b657c';

describe('log redaction of the VNPay signature', () => {
  it('drops vnp_SecureHash, name and value, from a request line, wherever it is', () => {
    expect(
      redactUrl(`/payments/vnpay/ipn?vnp_Amount=1000000&vnp_SecureHash=${HASH}&vnp_TxnRef=166117`),
    ).toBe('/payments/vnpay/ipn?vnp_Amount=1000000&vnp_TxnRef=166117');
    expect(redactUrl(`/payments/vnpay/return?vnp_TxnRef=1&vnp_SecureHash=${HASH}`)).toBe(
      '/payments/vnpay/return?vnp_TxnRef=1',
    );
  });

  it('also when the key is percent-encoded or repeated, and drops a "?" left empty', () => {
    expect(redactUrl(`/x?vnp%5FSecureHash=${HASH}&vnp_SecureHash=${HASH}`)).toBe('/x');
    expect(redactUrl(`/x?vnp_SecureHash`)).toBe('/x');
  });

  it('leaves other URLs and parameters alone', () => {
    expect(redactUrl('/payments/vnpay/ipn')).toBe('/payments/vnpay/ipn');
    expect(redactUrl('/bookings?status=PENDING&page=2')).toBe('/bookings?status=PENDING&page=2');
    expect(redactUrl('/x?broken=%E0%A4%A&flag')).toBe('/x?broken=%E0%A4%A&flag');
  });

  it('drops it from the parsed query too', () => {
    expect(redactQuery({ vnp_TxnRef: '166117', vnp_SecureHash: HASH })).toEqual({
      vnp_TxnRef: '166117',
    });
    expect(redactQuery(undefined)).toBeUndefined();
  });

  it('redactRequest keeps every other field of the serialized request', () => {
    const req = {
      id: 'r1',
      method: 'GET',
      url: `/payments/vnpay/ipn?vnp_TxnRef=1&vnp_SecureHash=${HASH}`,
      query: { vnp_TxnRef: '1', vnp_SecureHash: HASH },
      headers: { host: 'localhost:3000' },
    };

    expect(redactRequest(req)).toEqual({
      ...req,
      url: '/payments/vnpay/ipn?vnp_TxnRef=1',
      query: { vnp_TxnRef: '1' },
    });
    const logged = JSON.stringify(redactRequest(req));
    expect(logged).not.toContain(HASH);
    expect(logged).not.toContain('vnp_SecureHash');
  });
});

describe('log redaction of the MoMo signature (return URL, 11/2026)', () => {
  const SIGNATURE = 'e02b518060ddf1e8705ca680dddd0b4a59fc43ab41f4570ca00cbcc4eadb1783';
  const query =
    'partnerCode=MOMOTKF&orderId=Bq2qmIzmEDBQ2nWyKR55&requestId=5f0c6d1e&amount=180000' +
    `&resultCode=0&transId=4088878653&signature=${SIGNATURE}`;

  it('drops signature, name and value, from the request line and keeps the useful parameters', () => {
    expect(redactUrl(`/payments/momo/return?${query}`)).toBe(
      '/payments/momo/return?partnerCode=MOMOTKF&orderId=Bq2qmIzmEDBQ2nWyKR55' +
        '&requestId=5f0c6d1e&amount=180000&resultCode=0&transId=4088878653',
    );
    expect(redactUrl(`/payments/momo/return?signature=${SIGNATURE}`)).toBe('/payments/momo/return');
    expect(redactUrl(`/x?sig%6Eature=${SIGNATURE}&a=1`)).toBe('/x?a=1');
  });

  it('drops it from the parsed query, and the VNPay hash still goes too', () => {
    expect(
      redactQuery({ orderId: 'Bq2qmIzmEDBQ2nWyKR55', resultCode: '0', signature: SIGNATURE }),
    ).toEqual({ orderId: 'Bq2qmIzmEDBQ2nWyKR55', resultCode: '0' });
    expect(redactQuery({ vnp_TxnRef: '1', vnp_SecureHash: HASH, signature: SIGNATURE })).toEqual({
      vnp_TxnRef: '1',
    });
  });

  it('a serialized request keeps no trace of the signature', () => {
    const logged = JSON.stringify(
      redactRequest({
        method: 'GET',
        url: `/payments/momo/return?${query}`,
        query: Object.fromEntries(new URLSearchParams(query)),
      }),
    );
    expect(logged).not.toContain(SIGNATURE);
    expect(logged).not.toContain('signature');
    expect(logged).toContain('Bq2qmIzmEDBQ2nWyKR55');
    expect(logged).toContain('resultCode');
  });
});
