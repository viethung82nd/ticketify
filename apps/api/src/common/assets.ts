import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Finds a directory under `apps/api/assets` (fonts, email templates).
 *
 * Walks up from the calling module instead of trusting the working directory, so the same code
 * works from `src` (Jest, tsx), from `dist` (where `nest build` copies `assets`, see
 * nest-cli.json) and inside a container started from somewhere else entirely.
 */
export function findAssetDir(relativeDir: string, expectedFile: string): string {
  const searched: string[] = [];
  let directory = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, 'assets', relativeDir);
    searched.push(candidate);
    if (existsSync(join(candidate, expectedFile))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new AssetsMissingError(relativeDir, searched);
}

/** An asset directory is missing: a deployment without `assets`, or a bad build. */
export class AssetsMissingError extends Error {
  constructor(relativeDir: string, searched: readonly string[]) {
    super(`assets/${relativeDir} not found. Looked in: ${searched.join(', ')}`);
    this.name = 'AssetsMissingError';
  }
}
