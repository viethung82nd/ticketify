import { redactQuery, redactRequest, redactUrl } from './log-redaction';

const HASH = 'b6dababca5e07a2d8e32fdd3cf05c29cb426c721ae18e9589f7ad0e2db4b657c';

describe('log redaction of the VNPay signature', () => {
  it('replaces the value of vnp_SecureHash in a request line, wherever it is', () => {
    expect(
      redactUrl(`/payments/vnpay/ipn?vnp_Amount=1000000&vnp_SecureHash=${HASH}&vnp_TxnRef=166117`),
    ).toBe('/payments/vnpay/ipn?vnp_Amount=1000000&vnp_SecureHash=[redacted]&vnp_TxnRef=166117');
    expect(redactUrl(`/payments/vnpay/return?vnp_TxnRef=1&vnp_SecureHash=${HASH}`)).toBe(
      '/payments/vnpay/return?vnp_TxnRef=1&vnp_SecureHash=[redacted]',
    );
  });

  it('also when the key is percent-encoded or repeated', () => {
    expect(redactUrl(`/x?vnp%5FSecureHash=${HASH}&vnp_SecureHash=${HASH}`)).toBe(
      '/x?vnp%5FSecureHash=[redacted]&vnp_SecureHash=[redacted]',
    );
  });

  it('leaves other URLs and parameters alone', () => {
    expect(redactUrl('/payments/vnpay/ipn')).toBe('/payments/vnpay/ipn');
    expect(redactUrl('/bookings?status=PENDING&page=2')).toBe('/bookings?status=PENDING&page=2');
    expect(redactUrl('/x?broken=%E0%A4%A&flag')).toBe('/x?broken=%E0%A4%A&flag');
  });

  it('replaces it in the parsed query too', () => {
    expect(redactQuery({ vnp_TxnRef: '166117', vnp_SecureHash: HASH })).toEqual({
      vnp_TxnRef: '166117',
      vnp_SecureHash: '[redacted]',
    });
    expect(redactQuery(undefined)).toBeUndefined();
  });

  it('redactRequest keeps every other field of the serialized request', () => {
    const req = {
      id: 'r1',
      method: 'GET',
      url: `/payments/vnpay/ipn?vnp_SecureHash=${HASH}`,
      query: { vnp_SecureHash: HASH },
      headers: { host: 'localhost:3000' },
    };

    expect(redactRequest(req)).toEqual({
      ...req,
      url: '/payments/vnpay/ipn?vnp_SecureHash=[redacted]',
      query: { vnp_SecureHash: '[redacted]' },
    });
    expect(JSON.stringify(redactRequest(req))).not.toContain(HASH);
  });
});
