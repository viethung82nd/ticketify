/**
 * Source of "now" for all business logic (hold expiry, grace period, pricing day...).
 *
 * Inject this abstract class instead of calling `new Date()` / `Date.now()` so tests can
 * swap in `FakeClock` and move time deterministically. ESLint enforces the rule.
 */
export abstract class ClockService {
  /** Current instant. Always returns a fresh `Date` that callers may mutate. */
  abstract now(): Date;
}
