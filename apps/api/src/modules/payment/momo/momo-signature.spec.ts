import { createHmac } from 'node:crypto';
import {
  generateMomoSignature,
  MOMO_SIGNED_FIELDS,
  momoRawSignature,
  type MomoSignable,
  verifyMomoSignature,
} from './momo-signature';
import { momoSample as sample } from './testing/momo-sample';

/**
 * Signatures are pinned to `testing/momo-sample.json`, whose `raw` and `signature` were computed by
 * `testing/momo-reference.php` with the concatenation of MoMo's official PHP samples — not by the
 * code under test — so a wrong field, order or encoding here cannot hide behind itself.
 */
const credentials = sample.credentials;
const cases = sample.cases;
const ipn = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...cases.ipnSuccess.fields,
  signature: cases.ipnSuccess.signature,
  ...overrides,
});

describe('MoMo signatures — the official samples (PHP reference)', () => {
  it.each([
    ['create', cases.create],
    ['result (IPN)', cases.ipnSuccess],
    ['result with special characters, empty payType, a failure code', cases.ipnSpecialChars],
    ['query', cases.query],
  ])('%s: the raw text and the HMAC-SHA256 hex match the reference', (_label, testCase) => {
    const { message } = testCase;

    expect(momoRawSignature(message, testCase.fields, credentials.accessKey)).toBe(testCase.raw);
    expect(
      generateMomoSignature(message, testCase.fields as MomoSignable<typeof message>, credentials),
    ).toBe(testCase.signature);
  });

  it('special characters are signed as they are: no URL encoding, UTF-8 bytes', () => {
    const raw = momoRawSignature('result', cases.ipnSpecialChars.fields, credentials.accessKey);

    expect(raw).toContain('&orderInfo=Thanh toán vé #K7PX & combo=2 (bắp + nước) 100%&');
    expect(raw).toContain('&payType=&');
    expect(createHmac('sha256', credentials.secretKey).update(raw!, 'utf8').digest('hex')).toBe(
      cases.ipnSpecialChars.signature,
    );
  });

  it('the field lists are fixed (a–z, as documented) and never include signature or lang', () => {
    for (const fields of Object.values(MOMO_SIGNED_FIELDS)) {
      expect([...fields]).toEqual([...fields].sort());
      expect(fields).not.toContain('signature');
      expect(fields).not.toContain('lang');
    }
    expect(MOMO_SIGNED_FIELDS.result).toHaveLength(13);
  });
});

describe('verifyMomoSignature', () => {
  it('1. a valid signature (IPN body as MoMo sends it, numbers as JSON numbers)', () => {
    expect(verifyMomoSignature('result', ipn(), credentials)).toBe(true);
  });

  it('a valid signature in upper-case hex, and with every number sent as a string (redirect)', () => {
    const asStrings = Object.fromEntries(
      Object.entries(ipn({ signature: cases.ipnSuccess.signature.toUpperCase() })).map(
        ([key, value]) => [key, String(value)],
      ),
    );
    expect(verifyMomoSignature('result', asStrings, credentials)).toBe(true);
  });

  it('special characters and a failure code verify like any other value', () => {
    const body = { ...cases.ipnSpecialChars.fields, signature: cases.ipnSpecialChars.signature };
    expect(verifyMomoSignature('result', body, credentials)).toBe(true);
  });

  it('2. invalid: signed with another secret key', () => {
    expect(
      verifyMomoSignature('result', ipn(), { ...credentials, secretKey: 'another-secret-key' }),
    ).toBe(false);
  });

  it('2. invalid: another access key (it is part of the signed text)', () => {
    expect(
      verifyMomoSignature('result', ipn(), { ...credentials, accessKey: 'anotherAccessKey' }),
    ).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['63 hex characters', cases.ipnSuccess.signature.slice(1)],
    ['65 hex characters', `${cases.ipnSuccess.signature}0`],
    ['not hex', 'z'.repeat(64)],
    ['a number', 1234],
    ['an array (repeated key)', [cases.ipnSuccess.signature]],
  ])('3. missing or malformed signature (%s): invalid, nothing computed', (_label, signature) => {
    expect(verifyMomoSignature('result', ipn({ signature }), credentials)).toBe(false);
  });

  it.each([
    ['amount + 1 dong', { amount: 180_001 }],
    ['amount as a fraction', { amount: 180_000.5 }],
    ['amount with a leading zero (text)', { amount: '0180000' }],
  ])('4. modified amount (%s): invalid', (_label, overrides) => {
    expect(verifyMomoSignature('result', ipn(overrides), credentials)).toBe(false);
  });

  it.each([
    ['another order', { orderId: 'ZZZZZZZZZZZZZZZZZZZZ' }],
    ['one character changed', { orderId: 'Bq2qmIzmEDBQ2nWyKR56' }],
    ['trailing space', { orderId: 'Bq2qmIzmEDBQ2nWyKR55 ' }],
  ])('5. modified orderId (%s): invalid', (_label, overrides) => {
    expect(verifyMomoSignature('result', ipn(overrides), credentials)).toBe(false);
  });

  it('a failure dressed up as a success (resultCode changed after signing): invalid', () => {
    const body = { ...cases.ipnSpecialChars.fields, signature: cases.ipnSpecialChars.signature };
    expect(verifyMomoSignature('result', { ...body, resultCode: 0 }, credentials)).toBe(false);
  });

  it.each(MOMO_SIGNED_FIELDS.result.filter((field) => field !== 'accessKey'))(
    '6. missing signed field %s: invalid',
    (field) => {
      const body = ipn();
      delete body[field];
      expect(verifyMomoSignature('result', body, credentials)).toBe(false);
    },
  );

  it.each([
    ['null', null],
    ['an object', { value: 0 }],
    ['a number past 2^53', 2 ** 53 + 2],
  ])('6. a signed field that cannot be signed faithfully (%s): invalid', (_label, transId) => {
    expect(verifyMomoSignature('result', ipn({ transId }), credentials)).toBe(false);
  });

  it('8. incorrect field ordering: a signature over the same fields in another order is invalid', () => {
    const fields = cases.ipnSuccess.fields;
    const reordered = ['accessKey', ...Object.keys(fields)]
      .map((key) => `${key}=${key === 'accessKey' ? credentials.accessKey : String(fields[key])}`)
      .join('&');
    expect(reordered).not.toBe(cases.ipnSuccess.raw);
    const signature = createHmac('sha256', credentials.secretKey).update(reordered).digest('hex');

    expect(verifyMomoSignature('result', ipn({ signature }), credentials)).toBe(false);
  });

  it('the order of the keys in the received body does not matter (a fixed list is signed)', () => {
    const reversed = Object.fromEntries(Object.entries(ipn()).reverse());
    expect(verifyMomoSignature('result', reversed, credentials)).toBe(true);
  });

  it('a field outside the documented list (partnerUserId, lang) does not change the signature', () => {
    expect(
      verifyMomoSignature('result', ipn({ partnerUserId: 'u-1', lang: 'vi' }), credentials),
    ).toBe(true);
  });
});

describe('generateMomoSignature', () => {
  it('throws instead of signing a request with a missing field (a bug in our own payload)', () => {
    const fields: Record<string, unknown> = { ...cases.create.fields };
    delete fields.ipnUrl;
    expect(() =>
      generateMomoSignature('create', fields as MomoSignable<'create'>, credentials),
    ).toThrow('missing a signed field');
  });
});
