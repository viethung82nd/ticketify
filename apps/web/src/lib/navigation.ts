/**
 * Leaves the app for another site (a payment gateway's page). One function, so a test can replace
 * it: jsdom's `window.location` cannot be spied on.
 */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
