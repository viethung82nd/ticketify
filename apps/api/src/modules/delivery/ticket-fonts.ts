import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findAssetDir } from '../../common/assets';

/**
 * The Unicode fonts the ticket PDF is drawn with (ROADMAP 4.4).
 *
 * PDF's 14 standard fonts are WinAnsi-encoded, so Vietnamese diacritics come out as blanks or
 * boxes — "Mắt Biếc" would print as "M?t Bi?c". A TrueType font with the Vietnamese block must be
 * embedded instead; Be Vietnam Pro (SIL Open Font License 1.1) ships with the repo under
 * `apps/api/assets/fonts/be-vietnam-pro`, licence included.
 *
 * Read once and cached: a page of a PDF is drawn in milliseconds and the two files are ~270 KB
 * together, so re-reading them per ticket would be the slowest part of the job. A missing file
 * raises `AssetsMissingError`, which says where it looked.
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

const FONT_DIR = join('fonts', 'be-vietnam-pro');

let cached: Readonly<Record<TicketFont, Buffer>> | undefined;

/** Both font files, read from disk the first time and kept in memory afterwards. */
export function ticketFonts(): Readonly<Record<TicketFont, Buffer>> {
  if (cached) return cached;
  const directory = findAssetDir(FONT_DIR, FILES[TicketFont.REGULAR]);
  cached = {
    [TicketFont.REGULAR]: readFileSync(join(directory, FILES[TicketFont.REGULAR])),
    [TicketFont.SEMIBOLD]: readFileSync(join(directory, FILES[TicketFont.SEMIBOLD])),
  };
  return cached;
}
