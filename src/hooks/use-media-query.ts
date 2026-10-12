import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, kept up to date.
 *
 *     const wide = useMediaQuery('(min-width: 1024px)');
 *
 * False on the server and during hydration, so only use it for things that are
 * not rendered until the visitor has done something (as in the tool workspace).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
