import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The Unicode fonts the ticket PDF is drawn with (ROADMAP 4.4).
 *
 * PDF's 14 standard fonts are WinAnsi-encoded, so Vietnamese diacritics come out as blanks or
 * boxes — "Mắt Biếc" would print as "M?t Bi?c". A TrueType font with the Vietnamese block must be
 * embedded instead; Be Vietnam Pro (SIL Open Font License 1.1) ships with the repo under
 * `apps/api/assets/fonts/be-vietnam-pro`, licence included.
 *
 * Read once and cached: a page of a PDF is drawn in milliseconds and the two files are ~270 KB
 * together, so re-reading them per ticket would be the slowest part of the job.
 */

export const TicketFont = {
  REGULAR: 'BeVietnamPro',
  SEMIBOLD: 'BeVietnamPro-SemiBold',
} as const;
export type TicketFont = (typeof TicketFont)[keyof typeof TicketFont];

const FILES: Readonly<Record<TicketFont, string>> = {
  [TicketFont.REGULAR]: 'BeVietnamPro-Regular.ttf',
  [TicketFont.SEMIBOLD]: 'BeVietnamPro-SemiBold.ttf',
};

const FONT_DIR = join('assets', 'fonts', 'be-vietnam-pro');

/** The font files are missing: a deployment without the assets, or a bad build. */
export class TicketFontsMissingError extends Error {
  constructor(searched: readonly string[]) {
    super(
      `Ticket fonts not found. Looked for ${FONT_DIR} in: ${searched.join(', ')}. ` +
        'The PDF cannot be drawn without them: a standard PDF font cannot show Vietnamese.',
    );
    this.name = 'TicketFontsMissingError';
  }
}

let cached: Readonly<Record<TicketFont, Buffer>> | undefined;

/**
 * Walks up from this file looking for the font directory, so the same code works from `src`
 * (ts-node, Jest), from `dist` (the built API and worker, where `nest build` copies `assets`)
 * and from a container where the working directory is not the package root.
 */
function findFontDir(): string {
  const searched: string[] = [];
  let directory = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, FONT_DIR);
    searched.push(candidate);
    if (existsSync(join(candidate, FILES[TicketFont.REGULAR]))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new TicketFontsMissingError(searched);
}

/** Both font files, read from disk the first time and kept in memory afterwards. */
export function ticketFonts(): Readonly<Record<TicketFont, Buffer>> {
  if (cached) return cached;
  const directory = findFontDir();
  cached = {
    [TicketFont.REGULAR]: readFileSync(join(directory, FILES[TicketFont.REGULAR])),
    [TicketFont.SEMIBOLD]: readFileSync(join(directory, FILES[TicketFont.SEMIBOLD])),
  };
  return cached;
}
