import { Injectable } from '@nestjs/common';
import { ClockService } from './clock.service';

/** Real wall clock. The only place in the API allowed to read system time. */
@Injectable()
export class SystemClock extends ClockService {
  now(): Date {
    return new Date();
  }
}
