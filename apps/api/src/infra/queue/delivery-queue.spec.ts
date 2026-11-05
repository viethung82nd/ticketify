import { OutboxEventType } from '../outbox/outbox-events';
import {
  actionsOf,
  DELIVERY_ACTIONS,
  DeliveryAction,
  deliveryJobId,
  RELAYED_EVENT_TYPES,
} from './delivery-queue';

describe('deliveryJobId', () => {
  it('joins the event and the action with a dash', () => {
    expect(deliveryJobId('event-1', DeliveryAction.NOTIFY)).toBe('event-1-notify');
  });

  it('never contains a colon (BullMQ refuses custom ids with one)', () => {
    for (const action of Object.values(DeliveryAction)) {
      expect(deliveryJobId('01a3a1aa-7100-7679-b8b1-000000000001', action)).not.toContain(':');
    }
  });

  it('gives every action of one event its own id', () => {
    const ids = Object.values(DeliveryAction).map((action) => deliveryJobId('event-1', action));

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('DELIVERY_ACTIONS', () => {
  it('has an entry for every outbox event type', () => {
    expect(Object.keys(DELIVERY_ACTIONS).sort()).toEqual(Object.values(OutboxEventType).sort());
  });

  it('lists no action twice for one event type', () => {
    for (const actions of Object.values(DELIVERY_ACTIONS)) {
      expect(new Set(actions).size).toBe(actions.length);
    }
  });

  it('relays exactly the types that have an action', () => {
    expect([...RELAYED_EVENT_TYPES].sort()).toEqual(
      Object.values(OutboxEventType)
        .filter((type) => DELIVERY_ACTIONS[type].length > 0)
        .sort(),
    );
  });

  it('delivers released seats by broadcasting them', () => {
    expect(actionsOf(OutboxEventType.SEATS_RELEASED)).toEqual([DeliveryAction.BROADCAST_SEATS]);
  });

  it('answers with no action for an event type it does not know', () => {
    expect(actionsOf('something.else' as OutboxEventType)).toEqual([]);
  });
});
