import { useEffect, useState } from 'react';

/** Re-render often enough that the seconds never skip, cheap enough to leave running. */
const TICK_MS = 250;

/**
 * Milliseconds left until `deadline` on the SERVER's clock: `deadline − (now + serverOffsetMs)`,
 * never below 0. This machine's clock only measures elapsed time; `serverOffsetMs` (from the API's
 * `Date` header, see `serverOffsetOf`) corrects where it stands, so a clock set minutes off shows
 * the same countdown as everyone else.
 */
export function useCountdown(deadline: string, serverOffsetMs: number): number {
  const target = Date.parse(deadline);
  const left = () => Math.max(0, target - (Date.now() + serverOffsetMs));
  const [remaining, setRemaining] = useState(left);

  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, target - (Date.now() + serverOffsetMs)));
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [target, serverOffsetMs]);

  return remaining;
}

/** 125_000 → `02:05`. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
