/**
 * `smooth`, or `auto` (a jump) when the visitor asked the system for less motion. CSS cannot
 * override a `behavior: 'smooth'` passed to `scrollTo`/`scrollIntoView`, so scripts ask here.
 */
export const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
