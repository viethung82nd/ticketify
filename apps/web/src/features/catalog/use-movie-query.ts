import { type MovieListQuery, movieListQuerySchema } from '@ticketify/shared';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/** Changes to apply to the URL; `undefined` removes the parameter. */
export type QueryPatch = { [K in keyof MovieListQuery]?: MovieListQuery[K] | undefined };

/**
 * Movie list filters live in the query string, so reloads, links and the back button keep
 * them. Invalid values in a hand-edited URL fall back to defaults instead of failing.
 */
export function useMovieQuery(): [
  MovieListQuery,
  (patch: QueryPatch, options?: { replace?: boolean }) => void,
] {
  const [params, setParams] = useSearchParams();

  const query = useMemo(
    () => movieListQuerySchema.parse(Object.fromEntries(params.entries())),
    [params],
  );

  const update = useCallback(
    (patch: QueryPatch, { replace = false }: { replace?: boolean } = {}) => {
      // Start from the browser's current URL, not from `params`: React Router hands both
      // `params` and the functional `setSearchParams` the values of the last render, so a
      // debounced search firing right after a tab or genre change would undo that change.
      // Each user event or timer runs as its own task, by which time the URL is up to date.
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '' || (key === 'page' && value === 1)) {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      // Tabs and pages add history entries; typing in the search box replaces.
      setParams(next, { replace });
    },
    [setParams],
  );

  return [query, update];
}
