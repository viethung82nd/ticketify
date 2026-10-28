/**
 * Scenarios A and B run only with RUN_SCENARIO_TESTS=1 (the `booking-scenarios` workflow, or by
 * hand). Kept apart from `describeScenario` so global setup can read it without Jest globals.
 */
export const scenariosEnabled = process.env.RUN_SCENARIO_TESTS === '1';
