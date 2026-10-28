import { foldDiacritics } from '../movies/slug';

/**
 * Key two combo names must not share: no diacritics, lower case, single spaces.
 * "Bắp Rang  Bơ" and "bap rang bo" give the same key, so they are the same combo name.
 */
export const comboNameKey = (name: string): string =>
  foldDiacritics(name.normalize('NFC')).toLowerCase().replace(/\s+/g, ' ').trim();
