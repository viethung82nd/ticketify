import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalQuery, encodeVnpay, VnpayService } from './vnpay.service';

const fixtureSchema = z.object({
  source: z.url(),
  retrievedAt: z.iso.date(),
  official: z.object({ paymentUrl: z.string(), returnUrl: z.string() }),
  reference: z.object({
    hashSecret: z.string().min(1),
    cases: z.record(
      z.string(),
      z.object({
        params: z.record(z.string(), z.string()),
        hashData: z.string(),
        secureHash: z.string(),
      }),
    ),
  }),
});

const fixture = fixtureSchema.parse(
  JSON.parse(readFileSync(join(__dirname, 'testing', 'vnpay-sample.json'), 'utf8')),
);
const SECRET = fixture.reference.hashSecret;
const referenceCase = (name: string) => {
  const found = fixture.reference.cases[name];
  if (!found) throw new Error(`No reference case ${name}`);
  return found;
};

/** The raw query of a sample URL, split at `&vnp_SecureHash=` (always last in the samples). */
function splitSample(url: string): { signedPart: string; secureHash: string } {
  const query = url.slice(url.indexOf('?') + 1);
  const at = query.indexOf('&vnp_SecureHash=');
  return {
    signedPart: query.slice(0, at),
    secureHash: query.slice(at + '&vnp_SecureHash='.length),
  };
}

/** Decodes a query the way Express does (`+` is a space); a repeated key becomes an array. */
function parseQuery(query: string): Record<string, string | string[]> {
  const parsed: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    const previous = parsed[key];
    parsed[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return parsed;
}

describe('VnpayService', () => {
  const vnpay = new VnpayService();

  describe('official samples (signature secret not published: everything before the hash)', () => {
    it.each([
      ['payment URL', fixture.official.paymentUrl],
      ['return URL', fixture.official.returnUrl],
    ])('%s: the decoded parameters give back the exact signed part of the sample', (_, url) => {
      const { signedPart, secureHash } = splitSample(url);
      const params = parseQuery(signedPart);

      expect(canonicalQuery(params as Record<string, string>)).toBe(signedPart);
      // The sample hash is HMAC-SHA512 in lower-case hex, the format vnpaySignature produces.
      expect(secureHash).toMatch(/^[0-9a-f]{128}$/);
    });

    it('the payment URL sample decodes to the documented values (space and ":" in OrderInfo)', () => {
      const params = parseQuery(splitSample(fixture.official.paymentUrl).signedPart);
      expect(params).toMatchObject({
        vnp_Version: '2.1.0',
        vnp_Command: 'pay',
        vnp_Amount: '1806000',
        vnp_OrderInfo: 'Thanh toan don hang :5',
        vnp_ReturnUrl: 'https://domainmerchant.vn/ReturnUrl',
        vnp_OrderType: 'other',
      });
    });

    it('the sample hash does not verify with another secret (it is checked, not trusted)', () => {
      const query = fixture.official.paymentUrl.split('?')[1] ?? '';
      expect(vnpay.verifySignature(parseQuery(query), SECRET)).toBe(false);
    });
  });

  describe('reference signatures (VNPay PHP sample run with a test secret)', () => {
    it.each(Object.keys(fixture.reference.cases))(
      '%s: same signed data and same hash as the PHP sample',
      (name) => {
        const { params, hashData, secureHash } = referenceCase(name);

        expect(canonicalQuery(params)).toBe(hashData);
        expect(vnpay.buildSignedQuery(params, SECRET)).toBe(
          `${hashData}&vnp_SecureHash=${secureHash}`,
        );
      },
    );

    it.each(Object.keys(fixture.reference.cases))(
      '%s: the signed query verifies once parsed back',
      (name) => {
        const signed = vnpay.buildSignedQuery(referenceCase(name).params, SECRET);
        expect(vnpay.verifySignature(parseQuery(signed), SECRET)).toBe(true);
      },
    );

    it('Vietnamese, spaces and reserved characters in vnp_OrderInfo survive the round trip', () => {
      const { params } = referenceCase('vietnameseAndSpecialChars');
      const signed = vnpay.buildSignedQuery(params, SECRET);
      const parsed = parseQuery(signed);

      expect(parsed.vnp_OrderInfo).toBe(params.vnp_OrderInfo);
      expect(signed).toContain('vnp_OrderInfo=Thanh+to%C3%A1n+v%C3%A9+M%C3%B9a+H%C3%A8+');
      expect(signed).toContain('%7E%21%2A%27%40%23%26%3D%2B%2F%3F');
    });
  });

  describe('encodeVnpay', () => {
    it('space is "+", "!\'()*~" are encoded, only A–Z a–z 0–9 - _ . stay', () => {
      expect(encodeVnpay('a b')).toBe('a+b');
      expect(encodeVnpay("!'()*~")).toBe('%21%27%28%29%2A%7E');
      expect(encodeVnpay('Az09-_.')).toBe('Az09-_.');
      expect(encodeVnpay('ế')).toBe('%E1%BA%BF');
    });

    it('differs from encodeURIComponent exactly where the documentation does', () => {
      expect(encodeURIComponent('Thanh toan don hang :5')).toBe('Thanh%20toan%20don%20hang%20%3A5');
      expect(encodeVnpay('Thanh toan don hang :5')).toBe('Thanh+toan+don+hang+%3A5');
    });
  });

  describe('buildSignedQuery', () => {
    it('drops empty and undefined values, before sorting and signing', () => {
      const withEmpty = vnpay.buildSignedQuery(
        { vnp_TxnRef: 'abc', vnp_BankCode: '', vnp_Bill_Email: undefined, vnp_Amount: 100 },
        SECRET,
      );
      expect(withEmpty).toBe(
        vnpay.buildSignedQuery({ vnp_Amount: '100', vnp_TxnRef: 'abc' }, SECRET),
      );
      expect(withEmpty).not.toContain('vnp_BankCode');
      expect(withEmpty).not.toContain('vnp_Bill_Email');
    });

    it('sorts keys in ASCII order (upper case before lower case, "_" between them)', () => {
      const signed = vnpay.buildSignedQuery(
        { vnp_b: '1', vnp_Z: '2', vnp_a: '3', vnp_A: '4', vnp_A_x: '5', vnp_Ab: '6' },
        SECRET,
      );
      const keys = signed.split('&').map((pair) => pair.split('=')[0]);
      expect(keys).toEqual([
        'vnp_A',
        'vnp_A_x',
        'vnp_Ab',
        'vnp_Z',
        'vnp_a',
        'vnp_b',
        'vnp_SecureHash',
      ]);
    });

    it('the input order does not change the result', () => {
      expect(vnpay.buildSignedQuery({ vnp_b: '1', vnp_a: '2' }, SECRET)).toBe(
        vnpay.buildSignedQuery({ vnp_a: '2', vnp_b: '1' }, SECRET),
      );
    });

    it('never signs a vnp_SecureHash or vnp_SecureHashType passed in', () => {
      expect(
        vnpay.buildSignedQuery(
          { vnp_a: '1', vnp_SecureHash: 'x', vnp_SecureHashType: 'HmacSHA512' },
          SECRET,
        ),
      ).toBe(vnpay.buildSignedQuery({ vnp_a: '1' }, SECRET));
    });
  });

  describe('verifySignature', () => {
    const signedQuery = () =>
      parseQuery(vnpay.buildSignedQuery(referenceCase('docReturnSample').params, SECRET));

    it('one character changed in a value: invalid', () => {
      const query = signedQuery();
      expect(vnpay.verifySignature({ ...query, vnp_Amount: '1000001' }, SECRET)).toBe(false);
      expect(
        vnpay.verifySignature(
          { ...query, vnp_OrderInfo: `${String(query.vnp_OrderInfo)} ` },
          SECRET,
        ),
      ).toBe(false);
    });

    it('one character changed in the hash: invalid', () => {
      const query = signedQuery();
      const hash = String(query.vnp_SecureHash);
      const flipped = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`;
      expect(vnpay.verifySignature({ ...query, vnp_SecureHash: flipped }, SECRET)).toBe(false);
    });

    it('an added parameter: invalid; another secret: invalid', () => {
      const query = signedQuery();
      expect(vnpay.verifySignature({ ...query, vnp_Extra: '1' }, SECRET)).toBe(false);
      expect(vnpay.verifySignature(query, `${SECRET}x`)).toBe(false);
    });

    it('missing, empty, shorter, longer or repeated vnp_SecureHash: invalid, never throws', () => {
      const { vnp_SecureHash: hash, ...rest } = signedQuery();
      const value = String(hash);
      for (const candidate of [undefined, '', value.slice(1), `${value}0`, [value, value]]) {
        expect(vnpay.verifySignature({ ...rest, vnp_SecureHash: candidate }, SECRET)).toBe(false);
      }
      expect(vnpay.verifySignature(rest, SECRET)).toBe(false);
    });

    it('a repeated parameter (array after parsing): invalid', () => {
      const query = signedQuery();
      expect(vnpay.verifySignature({ ...query, vnp_TxnRef: ['166117', '1'] }, SECRET)).toBe(false);
    });

    it('vnp_SecureHashType is ignored; an upper-case hash is accepted', () => {
      const query = signedQuery();
      const upper = String(query.vnp_SecureHash).toUpperCase();
      expect(
        vnpay.verifySignature(
          { ...query, vnp_SecureHash: upper, vnp_SecureHashType: 'HmacSHA512' },
          SECRET,
        ),
      ).toBe(true);
    });
  });
});
