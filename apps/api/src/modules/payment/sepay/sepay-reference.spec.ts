import { newPaymentCode, referenceOf, VIETQR_IMAGE_URL, vietQrUrl } from './sepay-reference';

describe('SePay payment code', () => {
  it('is the prefix and 8 digits', () => {
    for (let i = 0; i < 200; i++) expect(newPaymentCode('TKF')).toMatch(/^TKF\d{8}$/);
  });

  it('is drawn at random', () => {
    const codes = new Set(Array.from({ length: 50 }, () => newPaymentCode('TKF')));
    expect(codes.size).toBeGreaterThan(45);
  });
});

describe('referenceOf', () => {
  it.each([
    ['SePay’s code', { code: 'TKF04817263', content: 'whatever' }, 'TKF04817263'],
    ['SePay’s code in lower case', { code: 'tkf04817263', content: null }, 'TKF04817263'],
    ['the content alone', { code: null, content: 'TKF04817263 chuyen tien' }, 'TKF04817263'],
    [
      'a bank-decorated content',
      { code: '', content: 'MBVCB.1234567.TKF04817263.CT tu 0123 NGUYEN VAN A' },
      'TKF04817263',
    ],
    ['a lower-case content', { content: 'thanh toan tkf04817263' }, 'TKF04817263'],
    [
      'another SePay code format, our code in content',
      { code: 'DH123456', content: 'DH123456 TKF04817263' },
      'TKF04817263',
    ],
    ['the same code twice', { content: 'TKF04817263 TKF04817263' }, 'TKF04817263'],
  ])('reads %s', (_label, transfer, expected) => {
    expect(referenceOf(transfer, 'TKF')).toBe(expected);
  });

  it.each([
    ['nothing', {}],
    ['another prefix', { code: 'ABC04817263', content: 'ABC04817263' }],
    ['7 digits', { content: 'TKF0481726' }],
    ['9 digits', { content: 'TKF048172631' }],
    ['digits glued after', { content: 'TKF04817263X' }],
    ['letters glued before', { content: 'XTKF04817263' }],
    ['two different codes', { content: 'TKF04817263 TKF11111111' }],
    ['letters in the suffix', { code: 'TKF0481726A' }],
  ])('finds none in %s', (_label, transfer) => {
    expect(referenceOf(transfer, 'TKF')).toBeNull();
  });
});

describe('vietQrUrl', () => {
  it('is the documented image URL with every value encoded', () => {
    const url = new URL(
      vietQrUrl({
        accountNumber: '1017588888',
        bankCode: 'Vietcombank',
        accountHolder: 'CONG TY TICKETIFY',
        amount: 180_000,
        transferContent: 'TKF04817263',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(VIETQR_IMAGE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      acc: '1017588888',
      bank: 'Vietcombank',
      amount: '180000',
      des: 'TKF04817263',
      template: 'compact',
      holder: 'CONG TY TICKETIFY',
    });
  });

  it('leaves the holder out when there is none', () => {
    const url = new URL(
      vietQrUrl({
        accountNumber: '1',
        bankCode: 'MB',
        accountHolder: null,
        amount: 1,
        transferContent: 'TKF00000001',
      }),
    );
    expect(url.searchParams.has('holder')).toBe(false);
  });
});
