import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CINEMA_TIME_ZONE } from '@ticketify/shared';
import { parse } from 'dotenv';
import { testConfig } from './testing/test-config';

/**
 * The web app shows every time in `DEFAULT_CINEMA_TIME_ZONE` from @ticketify/shared, while the
 * API reads CINEMA_TZ from its env schema. Both must name the same zone (CONTRIBUTING.md).
 */
describe('CINEMA_TZ parity between the API and @ticketify/shared', () => {
  it('the env schema default is DEFAULT_CINEMA_TIME_ZONE', () => {
    // testConfig() sets no CINEMA_TZ, so the schema default applies.
    expect(testConfig().get('CINEMA_TZ')).toBe(DEFAULT_CINEMA_TIME_ZONE);
  });

  it('.env.example uses the same zone', () => {
    const example = parse(readFileSync(join(__dirname, '../../../../.env.example')));
    expect(example.CINEMA_TZ).toBe(DEFAULT_CINEMA_TIME_ZONE);
  });
});
