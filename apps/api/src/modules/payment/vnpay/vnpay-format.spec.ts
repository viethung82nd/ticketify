import { newTxnRef, TXN_REF_LENGTH, vnpayDate, vnpayIpAddr } from './vnpay-format';

const at = (iso: string) => new Date(iso);

describe('vnpayDate', () => {
  it('formats the instant as yyyyMMddHHmmss in GMT+7', () => {
    expect(vnpayDate(at('2026-11-01T10:00:00.000Z'))).toBe('20261101170000');
  });

  it('rolls over the day, month and year at 17:00 UTC', () => {
    expect(vnpayDate(at('2026-12-31T16:59:59.000Z'))).toBe('20261231235959');
    expect(vnpayDate(at('2026-12-31T17:00:00.000Z'))).toBe('20270101000000');
  });

  it('truncates milliseconds instead of rounding', () => {
    expect(vnpayDate(at('2026-11-01T10:00:00.999Z'))).toBe('20261101170000');
  });
});

describe('newTxnRef', () => {
  it('is 20 letters and digits, different each time', () => {
    const refs = Array.from({ length: 200 }, newTxnRef);
    for (const ref of refs) expect(ref).toMatch(new RegExp(`^[A-Za-z0-9]{${TXN_REF_LENGTH}}$`));
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe('vnpayIpAddr', () => {
  it.each([
    ['203.113.0.45', '203.113.0.45'],
    ['::ffff:203.113.0.45', '203.113.0.45'],
    ['::FFFF:127.0.0.1', '127.0.0.1'],
    ['::1', '127.0.0.1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:not-an-ip', '::ffff:not-an-ip'],
    [undefined, '0.0.0.0'],
    ['', '0.0.0.0'],
  ])('%s → %s', (ip, expected) => {
    expect(vnpayIpAddr(ip)).toBe(expected);
  });
});
