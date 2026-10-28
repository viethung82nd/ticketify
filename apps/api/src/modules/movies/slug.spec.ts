import {
  firstFreeSlug,
  foldDiacritics,
  SEARCH_FOLD_FROM,
  SEARCH_FOLD_TO,
  searchPattern,
  SLUG_BASE_MAX,
  slugify,
} from './slug';

describe('slugify', () => {
  it.each([
    ['Mùa Hạ Cuối Cùng', 'mua-ha-cuoi-cung'],
    ['Biệt Đội Sao Băng', 'biet-doi-sao-bang'],
    ['đường về nhà', 'duong-ve-nha'],
    ['ĐẤT RỪNG PHƯƠNG NAM', 'dat-rung-phuong-nam'],
    ['Người Ơi! Ở Lại… (Phần 2)', 'nguoi-oi-o-lai-phan-2'],
    ['  Căn Nhà Số 13  ', 'can-nha-so-13'],
    ['Spider-Man: Across the Spider-Verse', 'spider-man-across-the-spider-verse'],
    ['Amélie & Co.', 'amelie-co'],
    ['A___B---C', 'a-b-c'],
  ])('%s → %s', (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it('folds titles typed in decomposed form (NFD) the same way', () => {
    expect(slugify('Mùa Hạ'.normalize('NFD'))).toBe('mua-ha');
  });

  it.each(['!!!', '   ', '—…—', '東京物語', ''])(
    'returns "" when nothing usable remains: %j',
    (title) => {
      expect(slugify(title)).toBe('');
    },
  );

  it('cuts long titles on a word boundary without a trailing hyphen', () => {
    const slug = slugify('phim '.repeat(40));

    expect(slug.length).toBeLessThanOrEqual(SLUG_BASE_MAX);
    expect(slug).toMatch(/^phim(-phim)*$/);
  });

  it('cuts a single very long word hard', () => {
    expect(slugify('a'.repeat(150))).toBe('a'.repeat(SLUG_BASE_MAX));
  });
});

describe('firstFreeSlug', () => {
  it('keeps the base when free', () => {
    expect(firstFreeSlug('phim', new Set(['phim-2']))).toBe('phim');
  });

  it('appends -2, -3… to the first gap', () => {
    expect(firstFreeSlug('phim', new Set(['phim']))).toBe('phim-2');
    expect(firstFreeSlug('phim', new Set(['phim', 'phim-2', 'phim-3']))).toBe('phim-4');
    expect(firstFreeSlug('phim', new Set(['phim', 'phim-3']))).toBe('phim-2');
  });
});

describe('accent-insensitive search', () => {
  it('maps every Vietnamese letter one-to-one for SQL translate()', () => {
    expect([...SEARCH_FOLD_FROM]).toHaveLength([...SEARCH_FOLD_TO].length);
    expect(SEARCH_FOLD_TO).toMatch(/^[a-zA-Z]+$/);
    expect(SEARCH_FOLD_FROM).toContain('ữ');
    expect(SEARCH_FOLD_FROM).toContain('Đ');
  });

  it('builds a folded, lower-case contains-pattern', () => {
    expect(searchPattern('  Mùa   HẠ ')).toBe('%mua ha%');
    expect(foldDiacritics('Đà Nẵng')).toBe('Da Nang');
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(searchPattern('100%_a\\b')).toBe('%100\\%\\_a\\\\b%');
  });
});
