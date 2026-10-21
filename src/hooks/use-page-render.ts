import { useEffect, useRef, useState } from 'react';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';

/** Wait this long after the width stops changing before rendering again at the new width. */
const RERENDER_DELAY_MS = 140;

interface Render {
  doc: PdfDocHandle;
  pageIndex: number;
  url: string;
}

/**
 * One page of `doc`, rendered as a lossless PNG at `cssWidth` (times the device
 * pixel ratio, under the handle's pixel budget), for a view where the page is
 * inspected for quality. Re-renders when the width settles; every render it
 * replaces is released. Returns null until a render of this page of this
 * document exists — never a render of another page or document.
 */
export function usePageRender(doc: PdfDocHandle | null, pageIndex: number, cssWidth: number): string | null {
  const [render, setRender] = useState<Render | null>(null);
  const current = useRef<Render | null>(null);
  const hasCurrent = !!render && render.doc === doc && render.pageIndex === pageIndex;

  useEffect(() => {
    if (!doc || doc.destroyed || pageIndex < 0 || pageIndex >= doc.pageCount || cssWidth <= 0) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        doc.renderPage(pageIndex, { cssWidth, format: 'png', signal: controller.signal }).then(
          (result) => {
            if (controller.signal.aborted) {
              doc.releasePage(result.url);
              return;
            }
            const old = current.current;
            current.current = { doc, pageIndex, url: result.url };
            setRender(current.current);
            if (old && !old.doc.destroyed) old.doc.releasePage(old.url);
          },
          () => {},
        );
      },
      hasCurrent ? RERENDER_DELAY_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `hasCurrent` only chooses the delay; it must not restart the render it describes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageIndex, cssWidth]);

  useEffect(
    () => () => {
      const old = current.current;
      if (old && !old.doc.destroyed) old.doc.releasePage(old.url);
      current.current = null;
    },
    [],
  );

  return hasCurrent ? render.url : null;
}
