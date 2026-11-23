import {
  parseSepayWebhook,
  SEPAY_TIMESTAMP_TOLERANCE_SECONDS,
  signSepayWebhook,
  verifySepaySignature,
} from './sepay-webhook.validator';
import { sepaySample, sepaySampleBody } from './testing/sepay-sample';

const NOW = new Date(sepaySample.timestampIso);
const raw = (body: string = sepaySample.rawBody) => Buffer.from(body, 'utf8');
const verify = (overrides: Partial<Parameters<typeof verifySepaySignature>[0]> = {}) =>
  verifySepaySignature({
    secret: sepaySample.secret,
    signature: sepaySample.signature,
    timestamp: sepaySample.timestamp,
    rawBody: raw(),
    now: NOW,
    ...overrides,
  });

describe('SePay webhook signature (HMAC-SHA256 over "{timestamp}.{raw body}")', () => {
  it('matches the HMAC computed independently with openssl', () => {
    expect(signSepayWebhook(sepaySample.secret, sepaySample.timestamp, raw())).toBe(
      sepaySample.signature,
    );
    expect(verify()).toEqual({ ok: true });
  });

  it('accepts the edges of the ±300 s replay window', () => {
    for (const offset of [-SEPAY_TIMESTAMP_TOLERANCE_SECONDS, SEPAY_TIMESTAMP_TOLERANCE_SECONDS]) {
      const now = new Date(NOW.getTime() + offset * 1000);
      expect(verify({ now })).toEqual({ ok: true });
    }
  });

  it.each([
    ['301 s late', 301],
    ['301 s early', -301],
    ['a day late', 86_400],
  ])('refuses a timestamp %s (replay)', (_label, offset) => {
    const now = new Date(NOW.getTime() + offset * 1000);
    expect(verify({ now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('replay') as unknown,
    });
  });

  it.each([
    ['another secret', { secret: 'another-secret-of-sufficient-length' }],
    [
      'a body changed by one byte',
      { rawBody: raw(sepaySample.rawBody.replace('180000', '180001')) },
    ],
    ['the same JSON re-serialized', { rawBody: raw(JSON.stringify(sepaySampleBody(), null, 1)) }],
    [
      'a signature in upper-case hex',
      { signature: sepaySample.signature.toUpperCase().replace('SHA256=', 'sha256=') },
    ],
    ['a signature cut short', { signature: sepaySample.signature.slice(0, -2) }],
  ])('refuses %s', (_label, overrides) => {
    expect(verify(overrides)).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it.each([
    ['no signature header', { signature: undefined }],
    ['a signature without "sha256="', { signature: sepaySample.signature.slice(7) }],
    ['a repeated signature header', { signature: [sepaySample.signature, sepaySample.signature] }],
    ['no timestamp header', { timestamp: undefined }],
    ['a timestamp that is not digits', { timestamp: '1764000000.5' }],
    ['a repeated timestamp header', { timestamp: [sepaySample.timestamp] }],
    ['no raw body', { rawBody: undefined }],
    ['an empty raw body', { rawBody: Buffer.alloc(0) }],
  ])('refuses %s', (_label, overrides) => {
    expect(verify(overrides as Parameters<typeof verify>[0])).toMatchObject({ ok: false });
  });
});

describe('SePay webhook payload', () => {
  it('reads the documentation sample', () => {
    const parsed = parseSepayWebhook(sepaySampleBody());
    expect(parsed).toEqual({
      ok: true,
      webhook: expect.objectContaining({
        id: 92704,
        accountNumber: '1017588888',
        code: 'TKF04817263',
        transferType: 'in',
        transferAmount: 180_000,
      }) as unknown,
    });
  });

  it('reads the Test-mode shape (no description, null code, extra fields kept)', () => {
    const { description: _d, ...body } = sepaySampleBody();
    const parsed = parseSepayWebhook({ ...body, code: null, somethingNew: 1 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.webhook).toMatchObject({ code: null, somethingNew: 1 });
  });

  it.each([
    ['not an object', 'id=92704'],
    ['an array', [sepaySampleBody()]],
    ['null', null],
    ['id as a string', { ...sepaySampleBody(), id: '92704' }],
    ['id 0', { ...sepaySampleBody(), id: 0 }],
    ['a fractional id', { ...sepaySampleBody(), id: 1.5 }],
    ['an unsafe id', { ...sepaySampleBody(), id: 2 ** 53 }],
    ['transferType IN', { ...sepaySampleBody(), transferType: 'IN' }],
    ['an unknown transferType', { ...sepaySampleBody(), transferType: 'refund' }],
    ['a missing transferType', { ...sepaySampleBody(), transferType: undefined }],
    ['transferAmount as a string', { ...sepaySampleBody(), transferAmount: '180000' }],
    ['a negative transferAmount', { ...sepaySampleBody(), transferAmount: -1 }],
    ['a fractional transferAmount', { ...sepaySampleBody(), transferAmount: 1000.5 }],
    ['no accountNumber', { ...sepaySampleBody(), accountNumber: undefined }],
    ['an empty accountNumber', { ...sepaySampleBody(), accountNumber: '' }],
    ['a numeric content', { ...sepaySampleBody(), content: 123 }],
  ])('refuses %s', (_label, body) => {
    const parsed = parseSepayWebhook(body);
    expect(parsed.ok).toBe(false);
  });

  it('names the field, never its value, in the reason', () => {
    const parsed = parseSepayWebhook({ ...sepaySampleBody(), transferAmount: 'secret-ish' });
    expect(parsed).toEqual({
      ok: false,
      reason: expect.stringMatching(/^transferAmount: /) as unknown,
    });
    expect(JSON.stringify(parsed)).not.toContain('secret-ish');
  });
});
