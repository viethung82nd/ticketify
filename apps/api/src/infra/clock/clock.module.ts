import { Global, Module } from '@nestjs/common';
import { ClockService } from './clock.service';
import { SystemClock } from './system-clock';

/** Provides `ClockService`. Tests override it with `FakeClock`. */
@Global()
@Module({
  providers: [{ provide: ClockService, useClass: SystemClock }],
  exports: [ClockService],
})
export class ClockModule {}
