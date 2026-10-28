/** Strips Vietnamese (and other Latin) diacritics: "Đường Về Nhà" → "Duong Ve Nha". */
export function foldDiacritics(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/**
 * Longest slug generated from a title, leaving room for a `-N` suffix within
 * `CATALOG_LIMITS.slugMax`.
 */
export const SLUG_BASE_MAX = 100;

/**
 * URL slug: no diacritics, lower case, every run of other characters becomes one `-`,
 * no leading/trailing `-`, cut to `maxLength` on a word boundary when possible.
 * Returns `''` when nothing usable remains (e.g. "!!!" or a title in another script).
 */
export function slugify(text: string, maxLength = SLUG_BASE_MAX): string {
  const slug = foldDiacritics(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
}

/** `base`, or `base-2`, `base-3`… — the first one not in `taken`. */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ─── Accent-insensitive search without a normalized column or the `unaccent` extension ───

const VIETNAMESE_LOWER = 'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ';
const VIETNAMESE_LETTERS = (VIETNAMESE_LOWER + VIETNAMESE_LOWER.toUpperCase()).normalize('NFC');

/**
 * Arguments for Postgres `translate(title, FROM, TO)`: every precomposed Vietnamese letter and
 * its base letter, position by position. Titles are stored NFC, so this covers Vietnamese;
 * other accented letters (ñ, ü…) are not folded on the database side.
 */
export const SEARCH_FOLD_FROM = VIETNAMESE_LETTERS;
export const SEARCH_FOLD_TO = [...VIETNAMESE_LETTERS]
  .map((letter) => foldDiacritics(letter))
  .join('');

/** `LIKE` pattern (escape character `\`) matching titles that contain `query`, folded. */
export function searchPattern(query: string): string {
  const folded = foldDiacritics(query.normalize('NFC'))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${folded}%`;
}
