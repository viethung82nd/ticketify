import type { AxiosResponse } from 'axios';

/**
 * Difference between the API's clock and this machine's, from one response:
 * `serverOffsetMs = Date header − local time when the response arrived`. Countdowns then use
 * `now + serverOffsetMs`, so a visitor whose clock is minutes off still sees the server's time.
 *
 * `null` when the header cannot be read: the API exposes it through CORS
 * (`Access-Control-Expose-Headers: Date`); a proxy that drops it, or an older API, leaves the
 * browser no way to see it. Callers then fall back to an offset of 0 and say the time may be off.
 *
 * Precision: the header has whole seconds, so the offset is within about one second (plus half
 * the round trip).
 */
export function serverOffsetOf(response: AxiosResponse, receivedAt: number): number | null {
  const header: unknown = response.headers.date;
  if (typeof header !== 'string') return null;
  const serverTime = Date.parse(header);
  return Number.isNaN(serverTime) ? null : serverTime - receivedAt;
}
