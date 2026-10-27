import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { seedEnvSchema } from '../../prisma/seed/env';
import { envSchema, validateEnv } from './env.schema';

/** Keys owned by other consumers of the shared .env (not by the API runtime schema). */
const FOREIGN_KEY_PREFIXES = ['VITE_'];

const examplePath = join(__dirname, '../../../../.env.example');
const example = parse(readFileSync(examplePath));

/** Every variable a backend process (API or seed) reads from the shared .env. */
const knownKeys = [...Object.keys(envSchema.shape), ...Object.keys(seedEnvSchema.shape)];

const isForeign = (key: string): boolean =>
  FOREIGN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

describe('.env.example', () => {
  it('passes API and seed validation as-is', () => {
    expect(() => validateEnv(example)).not.toThrow();
    expect(seedEnvSchema.safeParse(example).success).toBe(true);
  });

  it('documents every variable of the env schemas', () => {
    const missing = knownKeys.filter((key) => !(key in example));
    expect(missing).toEqual([]);
  });

  it('contains no variable unknown to the env schemas', () => {
    const known = new Set(knownKeys);
    const unknown = Object.keys(example).filter((key) => !known.has(key) && !isForeign(key));
    expect(unknown).toEqual([]);
  });
});
