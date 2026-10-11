import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The handle against a stand-in pdf.js and a stand-in canvas: what is tested
 * here is the handle's own bookkeeping — one document, URL ownership, thumbnail
 * subscriptions, cancellation and teardown order. Real rendering in real
 * browsers is covered by tests/e2e/tools/pdf-doc-layer.spec.ts.
 */

interface FakePage {
  view: number[];
  rotate: number;
  userUnit: number;
  getViewport: (o: { scale: number }) => { width: number; height: number; scale: number };
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  getTextContent: () => Promise<{ items: unknown[] }>;
}

const pdfjsState = vi.hoisted(() => ({
  /** What the next getDocument() does. */
  open: null as null | ((params: Record<string, unknown>) => { promise: Promise<unknown>; destroy: () => Promise<void> }),
  params: [] as Record<string, unknown>[],
}));

vi.mock('../pdfjs', () => ({
  PDFJS_DOC_ASSETS: { cMapUrl: '/pdfjs/cmaps/' },
  getPdfjs: async () => ({
    getDocument: (params: Record<string, unknown>) => {
      pdfjsState.params.push(params);
      return pdfjsState.open!(params);
    },
  }),
}));

import {
  defaultPixelBudget,
  fitToPixelBudget,
  isLowMemoryDevice,
  openPdf,
  PdfClosedError,
  PdfParseError,
  PdfPasswordError,
  toOpenError,
  LOW_MEMORY_DEVICE_GB,
  MAX_CANVAS_EDGE_PX,
  PIXEL_BUDGET_DEFAULT,
  PIXEL_BUDGET_LOW_MEMORY,
  THUMB_CACHE_LIMIT,
} from './doc-handle';
import { isRenderCancelled, PRIORITY_VISIBLE } from './render-scheduler';

/** A fake document of `pages` US-Letter pages whose renders finish when told to. */
function fakeDocument(pages: number, { manualRender = false } = {}) {
  const renders: Array<{ pageNumber: number; width: number; finish: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  let resolveDestroy!: () => void;
  const destroyed = new Promise<void>((r) => { resolveDestroy = r; });
  const destroy = vi.fn(() => destroyed);
  const getPage = vi.fn(async (pageNumber: number): Promise<FakePage> => ({
    view: [0, 0, 612, 792],
    rotate: 0,
    userUnit: 1,
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
    render: vi.fn(({ viewport }: { viewport: { width: number } }) => {
      let finish!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => { finish = res; reject = rej; });
      const cancel = vi.fn(() => reject(new Error('RenderingCancelledException')));
      renders.push({ pageNumber, width: viewport.width, finish, cancel });
      if (!manualRender) finish();
      return { promise, cancel };
    }),
    cleanup: vi.fn(),
    getTextContent: async () => ({ items: [{ str: `page ${pageNumber}` }, { type: 'beginMarkedContent' }] }),
  }));
  pdfjsState.open = () => ({ promise: Promise.resolve({ numPages: pages, getPage }), destroy });
  return { renders, destroy, finishDestroy: () => resolveDestroy(), getPage };
}

const canvas = { width: 0, height: 0, sizes: [] as string[] };
let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  pdfjsState.params.length = 0;
  canvas.width = 0;
  canvas.height = 0;
  canvas.sizes = [];
  created = [];
  revoked = [];
  let canvases = 0;
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('canvas');
      canvases++;
      // Only ever one: every render shares the scratch canvas.
      expect(canvases).toBeLessThanOrEqual(1);
      return Object.assign(canvas, {
        getContext: () => ({}),
        toBlob: (cb: (b: Blob) => void) => {
          canvas.sizes.push(`${canvas.width}x${canvas.height}`);
          cb(new Blob(['jpeg']));
        },
      });
    },
  });
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:test/${++n}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Wait until `check` stops throwing (the scheduler runs on real timers here). */
async function eventually(check: () => void, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { check(); return; } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

describe('pixel budget', () => {
  it('leaves a render that fits alone', () => {
    expect(fitToPixelBudget(612, 792, 1224)).toEqual({ widthPx: 1224, heightPx: 1584, scale: 2 });
  });

  it('shrinks a render over budget to the same shape, never above the budget', () => {
    for (const budget of [PIXEL_BUDGET_DEFAULT, PIXEL_BUDGET_LOW_MEMORY]) {
      const fit = fitToPixelBudget(612, 792, 6000, budget);
      expect(fit.widthPx * fit.heightPx).toBeLessThanOrEqual(budget);
      expect(fit.widthPx * fit.heightPx).toBeGreaterThan(budget * 0.99);
      expect(fit.widthPx / fit.heightPx).toBeCloseTo(612 / 792, 2);
    }
  });

  it('caps the long edge of a very long page', () => {
    const fit = fitToPixelBudget(200, 20_000, 400);
    expect(fit.heightPx).toBeLessThanOrEqual(MAX_CANVAS_EDGE_PX);
    expect(fit.widthPx).toBeGreaterThanOrEqual(1);
  });

  it('uses the small budget where the browser reports little memory, or reports nothing on a touch device', () => {
    expect(isLowMemoryDevice({ deviceMemory: LOW_MEMORY_DEVICE_GB })).toBe(true);
    expect(isLowMemoryDevice({ deviceMemory: 8 })).toBe(false);
    // Reported memory wins over the pointer type: a touch laptop with 8 GiB is not low-memory.
    expect(isLowMemoryDevice({ deviceMemory: 8, coarsePointer: true })).toBe(false);
    expect(isLowMemoryDevice({ coarsePointer: true })).toBe(true);
    expect(isLowMemoryDevice({ coarsePointer: false })).toBe(false);
    expect(isLowMemoryDevice({})).toBe(false);
    expect(defaultPixelBudget({ deviceMemory: 2 })).toBe(PIXEL_BUDGET_LOW_MEMORY);
    expect(defaultPixelBudget({ deviceMemory: 16 })).toBe(PIXEL_BUDGET_DEFAULT);
  });
});

describe('openPdf', () => {
  it('turns pdf.js password failures into PdfPasswordError and destroys the loading task', async () => {
    for (const [code, reason] of [[1, 'needed'], [2, 'incorrect']] as const) {
      const destroy = vi.fn(async () => {});
      pdfjsState.open = () => ({
        promise: Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException', code })),
        destroy,
      });
      const err = await openPdf(new ArrayBuffer(8)).catch((e) => e);
      expect(err).toBeInstanceOf(PdfPasswordError);
      expect(err.reason).toBe(reason);
      expect(destroy).toHaveBeenCalledTimes(1);
    }
  });

  it('turns every other failure into PdfParseError, keeping the cause', async () => {
    const cause = Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' });
    pdfjsState.open = () => ({ promise: Promise.reject(cause), destroy: async () => {} });
    const err = await openPdf(new ArrayBuffer(8)).catch((e) => e);
    expect(err).toBeInstanceOf(PdfParseError);
    expect(err.cause).toBe(cause);
    expect(toOpenError('nonsense')).toBeInstanceOf(PdfParseError);
  });

  it('opens the document once, with the shared assets, and passes the password on', async () => {
    fakeDocument(3);
    const doc = await openPdf(new ArrayBuffer(8), { password: 'secret' });
    await doc.geometry(0);
    await doc.textContent(1);
    await doc.requestThumb(2, 100);
    expect(pdfjsState.params).toHaveLength(1);
    expect(pdfjsState.params[0]).toMatchObject({ cMapUrl: '/pdfjs/cmaps/', password: 'secret' });
    expect(doc.pageCount).toBe(3);
  });

  it("copies an ArrayBuffer (pdf.js detaches what it is given) but hands a File's bytes straight over", async () => {
    fakeDocument(1);
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    await openPdf(buffer);
    const given = pdfjsState.params[0].data as Uint8Array;
    expect(given.buffer).not.toBe(buffer);
    expect([...given]).toEqual([1, 2, 3, 4]);
    expect(buffer.byteLength).toBe(4);

    await openPdf(new File([new Uint8Array([9, 8, 7])], 'a.pdf'));
    expect([...(pdfjsState.params[1].data as Uint8Array)]).toEqual([9, 8, 7]);
  });
});

describe('PdfDocHandle', () => {
  it('reports geometry and text from the one document, with zero-based page indexes', async () => {
    const { getPage } = fakeDocument(2);
    const doc = await openPdf(new ArrayBuffer(8));
    const geom = await doc.geometry(1);
    expect(geom).toMatchObject({ widthPt: 612, heightPt: 792, rotate: 0, userUnit: 1 });
    expect(getPage).toHaveBeenCalledWith(2);
    expect(await doc.geometry(1)).toBe(geom);
    expect(await doc.textContent(0)).toEqual([{ str: 'page 1' }]);
    await expect(doc.geometry(2)).rejects.toBeInstanceOf(RangeError);
    await expect(doc.renderPage(-1, { cssWidth: 100 })).rejects.toBeInstanceOf(RangeError);
  });

  it('renders a page to a blob URL at cssWidth × dpr, under the budget, and empties the scratch canvas', async () => {
    fakeDocument(1);
    const doc = await openPdf(new ArrayBuffer(8));

    const page = await doc.renderPage(0, { cssWidth: 600, dpr: 2 });
    expect(page).toEqual({ url: 'blob:test/1', widthPx: 1200, heightPx: 1553 });
    expect(canvas.sizes).toEqual(['1200x1553']);
    expect([canvas.width, canvas.height]).toEqual([0, 0]);

    const capped = await doc.renderPage(0, { cssWidth: 600, dpr: 2, pixelBudget: 500_000 });
    expect(capped.widthPx * capped.heightPx).toBeLessThanOrEqual(500_000);
    expect(capped.widthPx).toBeLessThan(1200);

    doc.releasePage(page.url);
    expect(revoked).toEqual(['blob:test/1']);
    doc.releasePage(page.url);
    doc.releasePage('blob:someone-elses');
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('cancels a render through its AbortSignal: pdf.js is told to stop and no URL is made', async () => {
    const { renders } = fakeDocument(1, { manualRender: true });
    const doc = await openPdf(new ArrayBuffer(8));
    const abort = new AbortController();
    const result = doc.renderPage(0, { cssWidth: 300, signal: abort.signal }).catch((e) => e);
    await eventually(() => expect(renders).toHaveLength(1));

    abort.abort();
    expect(isRenderCancelled(await result)).toBe(true);
    expect(renders[0].cancel).toHaveBeenCalledTimes(1);
    await eventually(() => expect([canvas.width, canvas.height]).toEqual([0, 0]));
    expect(created).toEqual([]);
  });

  it('thumbnails: one render per page however often it is asked for, and only that page is notified', async () => {
    const { renders } = fakeDocument(3);
    const doc = await openPdf(new ArrayBuffer(8));
    const seen: Record<number, Array<string | undefined>> = { 0: [], 1: [], 2: [] };
    const unsubscribe = [0, 1, 2].map((i) => doc.subscribeThumb(i, (url) => seen[i].push(url)));

    expect(doc.getThumb(1)).toBeUndefined();
    const first = doc.requestThumb(1, 200);
    const again = doc.requestThumb(1, 200);
    const smaller = doc.requestThumb(1, 80);
    expect(await first).toBe('blob:test/1');
    expect(await again).toBe('blob:test/1');
    expect(await smaller).toBe('blob:test/1');
    expect(await doc.requestThumb(1, 200)).toBe('blob:test/1');

    expect(renders.map((r) => r.pageNumber)).toEqual([2]);
    // 200 on the long edge of a 612 × 792 page.
    expect(canvas.sizes).toEqual(['155x200']);
    expect(doc.getThumb(1)).toBe('blob:test/1');
    expect(seen).toEqual({ 0: [], 1: ['blob:test/1'], 2: [] });

    unsubscribe[1]();
    await doc.requestThumb(1, 400);
    expect(seen[1]).toEqual(['blob:test/1']);
    // The larger render replaced the smaller one, whose URL is released.
    expect(doc.getThumb(1)).toBe('blob:test/2');
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('a thumbnail that fails resolves undefined instead of rejecting', async () => {
    const { getPage } = fakeDocument(2);
    const doc = await openPdf(new ArrayBuffer(8));
    getPage.mockRejectedValueOnce(new Error('damaged page'));
    expect(await doc.requestThumb(0, 100)).toBeUndefined();
    expect(doc.getThumb(0)).toBeUndefined();
    expect(await doc.requestThumb(1, 100)).toBe('blob:test/1');
  });

  it('keeps at most THUMB_CACHE_LIMIT thumbnails, evicting the least recently used that nobody watches', async () => {
    const pages = THUMB_CACHE_LIMIT + 3;
    fakeDocument(pages);
    const doc = await openPdf(new ArrayBuffer(8));
    const watched: Array<string | undefined> = [];
    doc.subscribeThumb(0, (url) => watched.push(url));

    // Visible priority only so the test does not sit through 300 idle waits.
    await Promise.all(Array.from({ length: pages }, (_, i) => doc.requestThumb(i, 50, { priority: PRIORITY_VISIBLE })));

    const held = Array.from({ length: pages }, (_, i) => doc.getThumb(i)).filter(Boolean);
    expect(held).toHaveLength(THUMB_CACHE_LIMIT);
    // Page 0 is the oldest but has a listener; pages 1–3 went instead.
    expect(doc.getThumb(0)).toBe('blob:test/1');
    expect([1, 2, 3].map((i) => doc.getThumb(i))).toEqual([undefined, undefined, undefined]);
    expect(revoked).toEqual(['blob:test/2', 'blob:test/3', 'blob:test/4']);
    expect(watched).toEqual(['blob:test/1']);
  }, 20_000);

  it('destroy cancels what is pending, revokes every URL and waits for pdf.js to finish tearing down', async () => {
    const { renders, destroy, finishDestroy } = fakeDocument(4, { manualRender: true });
    const doc = await openPdf(new ArrayBuffer(8));

    const done = doc.requestThumb(0, 100);
    await eventually(() => expect(renders).toHaveLength(1));
    renders[0].finish();
    expect(await done).toBe('blob:test/1');

    const running = doc.renderPage(1, { cssWidth: 300 }).catch((e) => e);
    const queued = doc.requestThumb(2, 100);
    await eventually(() => expect(renders).toHaveLength(2));

    let settled = false;
    const destroying = doc.destroy().then(() => { settled = true; });
    expect(doc.destroyed).toBe(true);
    expect(doc.destroy()).toBe(doc.destroy());

    // URLs go at once; the in-flight render is stopped; the queued one never starts.
    expect(revoked).toEqual(['blob:test/1']);
    expect(renders[1].cancel).toHaveBeenCalledTimes(1);
    expect(await running).toBeInstanceOf(PdfClosedError);
    expect(await queued).toBeUndefined();
    expect(doc.getThumb(0)).toBeUndefined();

    // pdf.js is asked to tear down only after the render has let go, and
    // destroy() does not resolve until pdf.js has.
    await eventually(() => expect(destroy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    finishDestroy();
    await destroying;
    expect(settled).toBe(true);

    expect(renders).toHaveLength(2);
    expect(created).toEqual(['blob:test/1']);
    await expect(doc.renderPage(0, { cssWidth: 100 })).rejects.toBeInstanceOf(PdfClosedError);
    await expect(doc.textContent(0)).rejects.toBeInstanceOf(PdfClosedError);
  });

  it('closeDocument tears pdf.js down but keeps the URLs until destroy', async () => {
    const { destroy, finishDestroy } = fakeDocument(2);
    const doc = await openPdf(new ArrayBuffer(8));
    await doc.requestThumb(0, 100);
    const page = await doc.renderPage(1, { cssWidth: 100, dpr: 1 });

    finishDestroy();
    await doc.closeDocument();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual([]);
    expect(doc.destroyed).toBe(false);
    expect(doc.getThumb(0)).toBe('blob:test/1');
    // Already-rendered thumbnails are still served; new work is refused quietly.
    expect(await doc.requestThumb(0, 100)).toBe('blob:test/1');
    expect(await doc.requestThumb(1, 100)).toBeUndefined();
    await expect(doc.renderPage(0, { cssWidth: 100 })).rejects.toBeInstanceOf(PdfClosedError);

    await doc.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(revoked.sort()).toEqual(['blob:test/1', page.url].sort());
  });
});
