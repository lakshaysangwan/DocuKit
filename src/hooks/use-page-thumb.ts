import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';

export interface UsePageThumbOptions {
  /**
   * Whether to ask for the thumbnail. Pass false for items that are off screen
   * in a long list so only what is visible is rendered; a thumbnail that already
   * exists is still returned. Defaults to true.
   */
  enabled?: boolean;
  /** Queue position (`PRIORITY_VISIBLE`, `PRIORITY_NEAR`, `PRIORITY_BACKGROUND`). */
  priority?: number;
}

const noSubscription = () => () => {};
const noThumb = () => undefined;

/**
 * The thumbnail URL for ONE page, or undefined until it has been rendered.
 *
 *     function Thumb({ doc, pageIndex }) {
 *       const src = usePageThumb(doc, pageIndex, 200);
 *       return src ? <img src={src} alt={`Page ${pageIndex + 1}`} /> : <Skeleton />;
 *     }
 *
 * Each component subscribes to its own page, so a thumbnail arriving re-renders
 * that one component and not the list around it. Give every page its own
 * component; do not call this in a loop from the parent.
 *
 * `longEdgePx` is the size of the longer side in device pixels — pass the CSS
 * size times the device pixel ratio you want to be sharp at.
 */
export function usePageThumb(
  doc: PdfDocHandle | null | undefined,
  pageIndex: number,
  longEdgePx: number,
  options: UsePageThumbOptions = {},
): string | undefined {
  const { enabled = true, priority } = options;
  const inRange = !!doc && !doc.destroyed && pageIndex >= 0 && pageIndex < doc.pageCount;

  const subscribe = useCallback(
    (onChange: () => void) => (doc && inRange ? doc.subscribeThumb(pageIndex, onChange) : noSubscription()),
    [doc, inRange, pageIndex],
  );
  const getSnapshot = useCallback(
    () => (doc && inRange ? doc.getThumb(pageIndex) : undefined),
    [doc, inRange, pageIndex],
  );
  const url = useSyncExternalStore(subscribe, getSnapshot, noThumb);

  useEffect(() => {
    if (doc && inRange && enabled) void doc.requestThumb(pageIndex, longEdgePx, { priority });
  }, [doc, inRange, enabled, pageIndex, longEdgePx, priority]);

  return url;
}
