import { ClockService } from '../clock.service';

/**
 * Controllable clock for tests. Time only moves when the test says so.
 *
 * ```ts
 * const clock = new FakeClock('2026-11-01T10:00:00Z');
 * moduleBuilder.overrideProvider(ClockService).useValue(clock);
 * clock.advance({ minutes: 15 });
 * ```
 */
export class FakeClock extends ClockService {
  private current: number;

  constructor(start: Date | string | number) {
    super();
    this.current = FakeClock.toEpoch(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Jumps to an absolute instant (may go backwards, e.g. to test clock skew). */
  set(instant: Date | string | number): void {
    this.current = FakeClock.toEpoch(instant);
  }

  /** Moves time forward by the given duration. */
  advance(duration: { ms?: number; seconds?: number; minutes?: number; hours?: number }): void {
    const { ms = 0, seconds = 0, minutes = 0, hours = 0 } = duration;
    const delta = ms + seconds * 1_000 + minutes * 60_000 + hours * 3_600_000;
    if (delta < 0) throw new RangeError('advance() only moves forward; use set() to go back');
    this.current += delta;
  }

  private static toEpoch(instant: Date | string | number): number {
    const epoch = new Date(instant).getTime();
    if (Number.isNaN(epoch)) throw new RangeError(`Invalid instant: ${String(instant)}`);
    return epoch;
  }
}
