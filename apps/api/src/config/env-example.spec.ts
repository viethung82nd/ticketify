import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { envSchema, validateEnv } from './env.schema';

/** Keys owned by other consumers of the shared .env (not by the API runtime schema). */
const FOREIGN_KEY_PREFIXES = ['VITE_'];

const examplePath = join(__dirname, '../../../../.env.example');
const example = parse(readFileSync(examplePath));

const isForeign = (key: string): boolean =>
  FOREIGN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

describe('.env.example', () => {
  it('passes validation as-is', () => {
    expect(() => validateEnv(example)).not.toThrow();
  });

  it('documents every variable of the env schema', () => {
    const missing = Object.keys(envSchema.shape).filter((key) => !(key in example));
    expect(missing).toEqual([]);
  });

  it('contains no variable unknown to the env schema', () => {
    const known = new Set(Object.keys(envSchema.shape));
    const unknown = Object.keys(example).filter((key) => !known.has(key) && !isForeign(key));
    expect(unknown).toEqual([]);
  });
});
