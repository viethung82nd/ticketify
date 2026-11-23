/**
 * Test-only SePay values: never real ones. `body` is the documentation's sample transaction
 * (developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook) with our payment code and amount; the
 * signature was computed outside this code base, with
 *   printf '%s' '<timestamp>.<rawBody>' | openssl dgst -sha256 -hmac '<secret>' -hex
 * so the verifier is checked against an independent HMAC, not against itself.
 */
export const sepaySample = {
  secret: 'unit-test-sepay-webhook-secret-0123',
  accountNumber: '1017588888',
  bankCode: 'Vietcombank',
  prefix: 'TKF',
  timestamp: '1764000000',
  /** 2025-11-24T16:00:00Z: `timestamp` as an instant. */
  timestampIso: '2025-11-24T16:00:00.000Z',
  rawBody:
    '{"id":92704,"gateway":"Vietcombank","transactionDate":"2024-07-02 11:08:33",' +
    '"accountNumber":"1017588888","subAccount":"","code":"TKF04817263",' +
    '"content":"TKF04817263 chuyen tien","transferType":"in",' +
    '"description":"NGUYEN VAN A chuyen tien","transferAmount":180000,' +
    '"accumulated":105000000,"referenceCode":"FT24012345678"}',
  signature: 'sha256=c72c8ce9aecd945449fd9ef852d6487cc53d07d53ada43b6d956bedfa6dd3ff2',
} as const;

/** The sample body, parsed. */
export const sepaySampleBody = (): Record<string, unknown> =>
  JSON.parse(sepaySample.rawBody) as Record<string, unknown>;
