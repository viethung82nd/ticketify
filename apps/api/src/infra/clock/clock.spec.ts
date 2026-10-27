import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClockModule } from './clock.module';
import { ClockService } from './clock.service';
import { SystemClock } from './system-clock';
import { FakeClock } from './testing/fake-clock';

/** Stand-in for a business service that depends on time. */
@Injectable()
class HoldPolicy {
  constructor(private readonly clock: ClockService) {}

  isExpired(heldUntil: Date): boolean {
    return heldUntil.getTime() <= this.clock.now().getTime();
  }
}

describe('ClockService', () => {
  it('ClockModule provides the system clock by default', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClockModule] }).compile();

    expect(moduleRef.get(ClockService)).toBeInstanceOf(SystemClock);
  });

  it('can be overridden with FakeClock to drive time in tests', async () => {
    const clock = new FakeClock('2026-11-01T10:00:00.000Z');
    const moduleRef = await Test.createTestingModule({
      imports: [ClockModule],
      providers: [HoldPolicy],
    })
      .overrideProvider(ClockService)
      .useValue(clock)
      .compile();
    const policy = moduleRef.get(HoldPolicy);
    const heldUntil = new Date('2026-11-01T10:10:00.000Z');

    expect(policy.isExpired(heldUntil)).toBe(false);
    clock.advance({ minutes: 9, seconds: 59 });
    expect(policy.isExpired(heldUntil)).toBe(false);
    clock.advance({ seconds: 1 });
    expect(policy.isExpired(heldUntil)).toBe(true);
  });
});

describe('FakeClock', () => {
  it('returns a fresh Date each call so callers cannot mutate its state', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    clock.now().setFullYear(2000);

    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('set() jumps to an absolute instant', () => {
    const clock = new FakeClock(0);
    clock.set('2027-04-30T17:00:00.000Z');

    expect(clock.now().toISOString()).toBe('2027-04-30T17:00:00.000Z');
  });

  it('rejects invalid instants and negative advances', () => {
    expect(() => new FakeClock('not a date')).toThrow(RangeError);
    expect(() => new FakeClock(0).advance({ ms: -1 })).toThrow(RangeError);
  });
});
