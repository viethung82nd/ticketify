import { createHash } from 'node:crypto';

export interface HoldPayload {
  showtimeId: string;
  seatIds: readonly string[];
  comboItems: readonly { comboId: string; quantity: number }[];
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON with object keys sorted at every level, so key order never changes the text. */
function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * SHA-256 (hex) of the normalized hold payload: ids lower-cased, `seatIds` sorted, `comboItems`
 * sorted by `comboId`, keys sorted. The same booking asked for in another order gives the same
 * hash. Neither the user nor the time is part of it: the `Idempotency-Key` is already per user.
 */
export function requestHash(payload: HoldPayload): string {
  const normalized: Json = {
    showtimeId: payload.showtimeId.toLowerCase(),
    seatIds: payload.seatIds.map((id) => id.toLowerCase()).sort(byString),
    comboItems: payload.comboItems
      .map((item) => ({ comboId: item.comboId.toLowerCase(), quantity: item.quantity }))
      .sort((a, b) => byString(a.comboId, b.comboId)),
  };
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}
