import { CATALOG_LIMITS } from '@ticketify/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { resolvePaging } from '../paging';
import { ListMoviesQueryDto } from './list-movies-query.dto';
import { CreateMovieDto, UpdateMovieDto } from './movie.dto';
import { PosterUploadDto } from './poster-upload.dto';

type DtoClass<T> = new () => T;

/** Same options as the global ValidationPipe. */
function check<T extends object>(cls: DtoClass<T>, plain: object) {
  const instance = plainToInstance(cls, plain);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, invalid: errors.map((error) => error.property) };
}

const GENRE_A = '01a17e75-7100-7679-b8b1-7acd80bbc3e9';
const GENRE_B = '01a17e75-7103-77d7-b455-1ee0cf9ee056';
const genreIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `01a17e75-7100-7679-b8b1-${String(i).padStart(12, '0')}`);

const validMovie = {
  title: 'Mùa Hạ Cuối Cùng',
  duration: 112,
  ageRating: 'T13',
  status: 'NOW_SHOWING',
  releaseDate: '2026-10-10',
  genreIds: [GENRE_A, GENRE_B],
};

describe('ListMoviesQueryDto + resolvePaging', () => {
  it('defaults page to 1 and pageSize to the endpoint default', () => {
    const { instance, invalid } = check(ListMoviesQueryDto, {});

    expect(invalid).toEqual([]);
    expect(resolvePaging(instance, CATALOG_LIMITS.publicPageSizeDefault)).toEqual({
      page: 1,
      pageSize: 12,
      skip: 0,
    });
    expect(resolvePaging(instance, CATALOG_LIMITS.adminPageSizeDefault).pageSize).toBe(20);
  });

  it('converts query strings and computes the offset', () => {
    const { instance, invalid } = check(ListMoviesQueryDto, { page: '3', pageSize: '50' });

    expect(invalid).toEqual([]);
    expect(resolvePaging(instance, 12)).toEqual({ page: 3, pageSize: 50, skip: 100 });
  });

  it.each([
    [{ page: '0' }, 'page'],
    [{ page: '-1' }, 'page'],
    [{ page: '1.5' }, 'page'],
    [{ page: 'abc' }, 'page'],
    [{ pageSize: '0' }, 'pageSize'],
    [{ pageSize: '51' }, 'pageSize'],
    [{ status: 'SHOWING' }, 'status'],
    [{ genre: 'Hành động' }, 'genre'],
    [{ q: 'x'.repeat(101) }, 'q'],
  ])('rejects %j', (query, field) => {
    expect(check(ListMoviesQueryDto, query).invalid).toEqual([field]);
  });

  it('treats a blank search as no search', () => {
    expect(check(ListMoviesQueryDto, { q: '   ' }).instance.q).toBeUndefined();
  });
});

describe('CreateMovieDto', () => {
  it('accepts a valid movie and trims the title', () => {
    const { instance, invalid } = check(CreateMovieDto, { ...validMovie, title: '  Phim  ' });

    expect(invalid).toEqual([]);
    expect(instance.title).toBe('Phim');
  });

  it.each([
    [{ title: '' }, 'title'],
    [{ title: 'x'.repeat(201) }, 'title'],
    [{ duration: 0 }, 'duration'],
    [{ duration: 401 }, 'duration'],
    [{ duration: 90.5 }, 'duration'],
    [{ ageRating: 'PG13' }, 'ageRating'],
    [{ status: 'SHOWING' }, 'status'],
    [{ releaseDate: '2026-11-14T00:00:00Z' }, 'releaseDate'],
    [{ releaseDate: '2026-02-30' }, 'releaseDate'],
    [{ releaseDate: '14/11/2026' }, 'releaseDate'],
    [{ genreIds: genreIds(6) }, 'genreIds'],
    [{ genreIds: [GENRE_A, GENRE_A] }, 'genreIds'],
    [{ genreIds: ['not-a-uuid'] }, 'genreIds'],
  ])('rejects %j', (override, field) => {
    expect(check(CreateMovieDto, { ...validMovie, ...override }).invalid).toEqual([field]);
  });

  it('allows exactly 5 genres', () => {
    expect(check(CreateMovieDto, { ...validMovie, genreIds: genreIds(5) }).invalid).toEqual([]);
  });

  it('rejects unknown fields such as a client-chosen slug', () => {
    expect(check(CreateMovieDto, { ...validMovie, slug: 'x' }).invalid).toEqual(['slug']);
  });
});

describe('UpdateMovieDto', () => {
  it('accepts an empty patch and posterKey: null (remove poster)', () => {
    expect(check(UpdateMovieDto, {}).invalid).toEqual([]);
    expect(check(UpdateMovieDto, { posterKey: null }).invalid).toEqual([]);
  });

  it('rejects null for non-nullable fields instead of skipping them', () => {
    expect(check(UpdateMovieDto, { title: null, duration: null }).invalid).toEqual([
      'title',
      'duration',
    ]);
  });

  it.each(['Mua Ha', 'mua--ha', '-mua', 'mùa-hạ'])('rejects slug %j', (slug) => {
    expect(check(UpdateMovieDto, { slug }).invalid).toEqual(['slug']);
  });
});

describe('PosterUploadDto', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', (contentType) => {
    expect(check(PosterUploadDto, { contentType, sizeBytes: 1024 }).invalid).toEqual([]);
  });

  it.each([
    [{ contentType: 'image/gif', sizeBytes: 1024 }, 'contentType'],
    [{ contentType: 'image/svg+xml', sizeBytes: 1024 }, 'contentType'],
    [{ contentType: 'image/png', sizeBytes: CATALOG_LIMITS.posterMaxBytes + 1 }, 'sizeBytes'],
    [{ contentType: 'image/png', sizeBytes: 0 }, 'sizeBytes'],
  ])('rejects %j', (body, field) => {
    expect(check(PosterUploadDto, body).invalid).toEqual([field]);
  });

  it('accepts exactly 2 MB', () => {
    const body = { contentType: 'image/png', sizeBytes: CATALOG_LIMITS.posterMaxBytes };
    expect(check(PosterUploadDto, body).invalid).toEqual([]);
  });
});
