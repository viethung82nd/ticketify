/** Hands started containers from global setup to global teardown (same process). */

export interface StoppableContainer {
  stop(): Promise<unknown>;
}

const KEY = Symbol.for('ticketify.test.containers');

type Holder = { [KEY]?: StoppableContainer[] };

export function setStartedContainers(containers: StoppableContainer[]): void {
  (globalThis as Holder)[KEY] = containers;
}

export function takeStartedContainers(): StoppableContainer[] {
  const holder = globalThis as Holder;
  const containers = holder[KEY] ?? [];
  delete holder[KEY];
  return containers;
}
