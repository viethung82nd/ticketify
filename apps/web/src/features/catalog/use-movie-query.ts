import { type MovieListQuery, movieListQuerySchema } from '@ticketify/shared';
import { useCallback, useEffect, useMemo, useRef } from 'react';
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

  /**
   * The newest params, including ones not rendered yet. React Router's functional
   * `setSearchParams` passes the params of the last render, so a debounced search firing
   * right after a tab click would otherwise undo the tab change.
   */
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);

  const query = useMemo(
    () => movieListQuerySchema.parse(Object.fromEntries(params.entries())),
    [params],
  );

  const update = useCallback(
    (patch: QueryPatch, { replace = false }: { replace?: boolean } = {}) => {
      const next = new URLSearchParams(latest.current);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '' || (key === 'page' && value === 1)) {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      latest.current = next;
      // Tabs and pages add history entries; typing in the search box replaces.
      setParams(next, { replace });
    },
    [setParams],
  );

  return [query, update];
}
