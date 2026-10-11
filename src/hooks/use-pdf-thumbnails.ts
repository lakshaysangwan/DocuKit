import { useState, useCallback, useEffect, useRef } from 'react';
import { openPdf, type PdfDocHandle } from '@/lib/pdf/doc-handle';
import { PRIORITY_VISIBLE } from '@/lib/pdf/render-scheduler';

export interface ThumbnailResult {
  pageIndex: number;
  /**
   * URL for `<img src>`. Despite the name (kept so callers need no edit) this is
   * a `blob:` URL owned by the hook, not a data URL: it is only good for
   * displaying, and it stops working once the hook loads another file, is
   * cleared, or unmounts.
   */
  dataUrl: string;
}

interface UsePdfThumbnailsResult {
  thumbnails: ThumbnailResult[];
  pageCount: number;
  isLoading: boolean;
  error: string | null;
  loadThumbnails: (buffer: ArrayBuffer, size?: number) => Promise<number>;
  clear: () => void;
}

/**
 * Thumbnails reach React state at most this often while pages are rendering.
 * The list this hook returns is one array, so every update re-renders the whole
 * grid; publishing per page made that quadratic in the page count.
 */
export const THUMBNAIL_FLUSH_INTERVAL_MS = 150;

const ENCRYPTED_MESSAGE =
  'This PDF is encrypted. Please use the Unlock PDF tool first to remove the password, then try again.';

/** One `loadThumbnails` call: its document, and whether it has been superseded. */
interface Session {
  cancelled: boolean;
  handle: PdfDocHandle | null;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Thumbnails of every page of one PDF, in page order.
 *
 * LEGACY ADAPTER. New code should use `usePdfDocument` + `usePageThumb`, which
 * render only what is on screen and re-render one page at a time. This keeps the
 * old signature for the tools that have not moved to the shared workspace yet,
 * on top of the same `PdfDocHandle`:
 *
 *   • the file is opened once, and the pdf.js document is closed as soon as the
 *     last thumbnail is rendered (it used to stay open for the life of the tab,
 *     one more per file loaded);
 *   • thumbnails are `blob:` URLs, revoked when another file is loaded, on
 *     `clear()` and on unmount;
 *   • `loadThumbnails` resolves with the page count as soon as the file is open,
 *     not after the last page has rendered, and `thumbnails` then grows in page
 *     order a batch at a time while `isLoading` stays true.
 *
 * `loadThumbnails` still resolves 0 (and sets `error`) when the file cannot be
 * opened, which is how its callers detect a bad or encrypted PDF.
 */
export function usePdfThumbnails(): UsePdfThumbnailsResult {
  const [thumbnails, setThumbnails] = useState<ThumbnailResult[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  /** Stop the current load, if any, and free its document and its URLs. */
  const release = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    session.cancelled = true;
    clearTimeout(session.flushTimer);
    void session.handle?.destroy();
  }, []);

  useEffect(() => release, [release]);

  const loadThumbnails = useCallback(async (buffer: ArrayBuffer, size = 800): Promise<number> => {
    release();
    const session: Session = { cancelled: false, handle: null, flushTimer: undefined };
    sessionRef.current = session;
    setIsLoading(true);
    setError(null);
    setThumbnails([]);

    let handle: PdfDocHandle;
    try {
      handle = await openPdf(buffer);
    } catch (err) {
      if (!session.cancelled) {
        const name = err instanceof Error ? err.name : '';
        setError(name === 'PdfPasswordError' ? ENCRYPTED_MESSAGE : err instanceof Error ? err.message : 'Failed to load PDF');
        setIsLoading(false);
      }
      return 0;
    }

    const count = handle.pageCount;
    if (session.cancelled) {
      // Another file was loaded, or the tool went away, while this one opened.
      // The file itself is fine, so the caller still gets its real page count.
      void handle.destroy();
      return count;
    }
    session.handle = handle;
    setPageCount(count);

    // Rendering carries on after the count has been returned.
    void (async () => {
      const done: ThumbnailResult[] = [];
      let published = 0;
      const flush = () => {
        session.flushTimer = undefined;
        if (session.cancelled || done.length === published) return;
        published = done.length;
        setThumbnails(done.slice());
      };

      let failure: string | null = null;
      for (let i = 0; i < count; i++) {
        // These are what the user is looking at, so they do not wait for idle
        // time; the scheduler still yields to input and paint between pages.
        const url = await handle.requestThumb(i, size, { priority: PRIORITY_VISIBLE });
        if (session.cancelled) return;
        if (!url) {
          // Callers index this array by position, so it must stay an unbroken
          // run of pages: stop at the first page that will not render.
          failure = `Page ${i + 1} could not be rendered.`;
          break;
        }
        done.push({ pageIndex: i, dataUrl: url });
        // The first page goes out at once so something appears immediately.
        if (done.length === 1) flush();
        else session.flushTimer ??= setTimeout(flush, THUMBNAIL_FLUSH_INTERVAL_MS);
      }

      clearTimeout(session.flushTimer);
      flush();
      if (failure) setError(failure);
      setIsLoading(false);
      // Nothing here needs the document again; the URLs outlive it.
      void handle.closeDocument();
    })();

    return count;
  }, [release]);

  const clear = useCallback(() => {
    release();
    setThumbnails([]);
    setPageCount(0);
    setIsLoading(false);
    setError(null);
  }, [release]);

  return { thumbnails, pageCount, isLoading, error, loadThumbnails, clear };
}
