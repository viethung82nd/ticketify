import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One pinned case of `momo-sample.json`: inputs, and what MoMo's PHP sample computes for them. */
export interface MomoSampleCase {
  message: 'create' | 'result' | 'query';
  fields: Record<string, string | number>;
  raw: string;
  signature: string;
}

export interface MomoSample {
  credentials: { partnerCode: string; accessKey: string; secretKey: string };
  cases: Record<'create' | 'ipnSuccess' | 'ipnSpecialChars' | 'query', MomoSampleCase>;
}

/** Test-only MoMo data (see the fixture's `comment`). */
export const momoSample = JSON.parse(
  readFileSync(join(__dirname, 'momo-sample.json'), 'utf8'),
) as MomoSample;
