import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { expectImageRendered, uploadFiles } from '../helpers/harness';

/**
 * The shared PDF document layer (src/lib/pdf) behind the page thumbnails, in a
 * real browser against the production build.
 *
 * These tests used to drive the legacy `usePdfThumbnails` hook through Redact
 * PDF. Redact now shows one page at a time through the document handle, the
 * hook is gone, and the thumbnails every migrated tool shows come from
 * `PdfDocHandle.requestThumb` via `usePageThumb`. Split PDF's page grid asks
 * for every page, so it is driven here. What is proven is the same as before:
 * blob: images that really decode, one pdf.js document, released when the file
 * changes and when the visitor leaves, a 48-page file shows its page count
 * before every thumbnail is drawn, and rendering is bounded (each page once, no
 * rebuilding of the grid as thumbnails arrive).
 *
 * One thing is different by design: the handle keeps its document open while
 * the tool shows the file (pages are drawn on demand), so "closed once the
 * thumbnails are done" became "exactly one open while shown, none after".
 *
 * Nothing in the app is instrumented for this. The page is observed from the
 * outside instead:
 *
 *   • `URL.createObjectURL` / `revokeObjectURL` are wrapped, so every JPEG
 *     raster URL the page makes and every URL it releases is on record;
 *   • messages to Web Workers are watched for pdf.js's own `GetDocRequest`
 *     (a document was opened) and `Terminate` (a document was torn down), so
 *     "how many pdf.js documents are alive" is opened − terminated.
 */
interface Probe {
  /** blob: URLs created for JPEG rasters, in order. */
  rasters: string[];
  revoked: string[];
  opened: number;
  terminated: number;
}

declare global {
  interface Window {
    __pdfProbe: Probe;
    __countWatch?: { rastersWhenCountShown: number | null; stop: () => void };
  }
}

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = { rasters: [], revoked: [], opened: 0, terminated: 0 };
    window.__pdfProbe = probe;

    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = create(obj);
      if (obj instanceof Blob && obj.type === 'image/jpeg') probe.rasters.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      probe.revoked.push(url);
      revoke(url);
    };

    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      const action = (message as { action?: string } | null)?.action;
      if (action === 'GetDocRequest') probe.opened++;
      if (action === 'Terminate') probe.terminated++;
      return (post as (...a: unknown[]) => void).call(this, message, ...rest);
    } as typeof post;
  });
}

const probe = (page: Page) => page.evaluate(() => window.__pdfProbe);
/**
 * Follow the header's link home and wait until the home page is the one shown.
 * A trailing slash is not enough: on the live site the tool's own address ends
 * in one too (/split-pdf/), so that would be true before the navigation began.
 */
async function goHome(page: Page) {
  await page.locator('header a[href="/"]').first().click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe('/');
}
const liveDocuments = async (page: Page) => {
  const p = await probe(page);
  return p.opened - p.terminated;
};
/** Split's page thumbnails, from the document handle. */
const thumbs = (page: Page) => page.getByTestId('split-page-image');
const thumbSources = (page: Page) =>
  thumbs(page).evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src));

async function openSplitWith(page: Page, file: string) {
  await page.goto('/split-pdf');
  await uploadFiles(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible({ timeout: 20_000 });
}

test.describe('PDF document layer behind the page thumbnails', () => {
  test('thumbnails are blob: images that really decode, from one open document', async ({ page }) => {
    await installProbe(page);
    await openSplitWith(page, FIXTURE.pdf5page);

    const images = thumbs(page);
    await expect(images).toHaveCount(5, { timeout: 20_000 });
    for (let i = 0; i < 5; i++) {
      await expectImageRendered(images.nth(i));
      expect(await images.nth(i).getAttribute('src')).toMatch(/^blob:/);
    }
    // At the grid's thumbnail size: 320px on the long edge at the default (small) size.
    const size = await images.first().evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
    expect(Math.max(...size)).toBe(320);

    // One pdf.js document, kept open while the file is shown.
    await expect.poll(() => liveDocuments(page), { timeout: 10_000 }).toBe(1);
    const p = await probe(page);
    expect(p.opened).toBe(1);
    // Every thumbnail shown is a raster the page made, and none of them is released while shown.
    const shown = new Set(await thumbSources(page));
    for (const url of shown) expect(p.rasters).toContain(url);
    expect(p.revoked.filter((url) => shown.has(url))).toEqual([]);
  });

  test('loading another file releases the previous file’s thumbnails and document', async ({ page }) => {
    await installProbe(page);
    await openSplitWith(page, FIXTURE.pdf3page);
    await expect(thumbs(page)).toHaveCount(3, { timeout: 20_000 });
    const first = await thumbSources(page);

    await page.getByRole('button', { name: 'Remove file' }).click();
    await expect(page.getByTestId('workspace')).toHaveCount(0);
    await uploadFiles(page, FIXTURE.pdf5page);
    await expect(thumbs(page)).toHaveCount(5, { timeout: 20_000 });
    const second = await thumbSources(page);

    const p = await probe(page);
    for (const url of first) expect(p.revoked).toContain(url);
    for (const url of second) expect(p.revoked).not.toContain(url);
    await expectImageRendered(thumbs(page).first());
    await expect.poll(() => liveDocuments(page), { timeout: 10_000 }).toBe(1);
  });

  test('leaving the tool releases its thumbnails and leaves no document open', async ({ page }) => {
    await installProbe(page);
    await openSplitWith(page, FIXTURE.pdf5page);
    await expect(thumbs(page)).toHaveCount(5, { timeout: 20_000 });
    const sources = await thumbSources(page);

    // Navigation is client-side (Astro's ClientRouter), so the page's JS — and
    // anything it leaked — would survive it. The probe surviving proves that.
    await goHome(page);
    // The tool lets go as Astro swaps the new page in, which can land just
    // after the address changes; so wait for it rather than look once.
    await expect
      .poll(async () => {
        const { revoked } = await probe(page);
        return sources.filter((url) => !revoked.includes(url));
      }, { timeout: 10_000, message: 'thumbnails still held after leaving the tool' })
      .toEqual([]);
    const p = await probe(page);
    expect(p.rasters.length, 'the document was not reloaded').toBeGreaterThanOrEqual(5);
    await expect.poll(() => liveDocuments(page), { timeout: 10_000 }).toBe(0);
  });

  test('leaving while thumbnails are still rendering stops the work and releases everything', async ({ page }) => {
    await installProbe(page);
    await openSplitWith(page, FIXTURE.pdf48page);
    await expect(thumbs(page).first()).toBeVisible({ timeout: 20_000 });

    await goHome(page);
    await expect.poll(() => liveDocuments(page), { timeout: 10_000 }).toBe(0);

    // Whatever had been rendered is released, and rendering does not carry on.
    await expect.poll(async () => {
      const p = await probe(page);
      return p.rasters.filter((url) => !p.revoked.includes(url)).length;
    }, { timeout: 10_000 }).toBe(0);
    const settled = (await probe(page)).rasters.length;
    await page.waitForTimeout(500);
    expect((await probe(page)).rasters.length).toBe(settled);
  });

  test('a 48-page PDF shows its page count before the thumbnails are drawn, renders each page once, and does not rebuild the grid', async ({ page }, testInfo) => {
    await installProbe(page);
    await page.goto('/split-pdf');
    await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible();

    // Note how many pages had been rasterised when "48 pages" first appeared.
    await page.evaluate(() => {
      const state = { rastersWhenCountShown: null as number | null, stop: () => observer.disconnect() };
      const observer = new MutationObserver(() => {
        if (state.rastersWhenCountShown !== null) return;
        if (/\b48 pages\b/.test(document.querySelector('[data-testid="workspace"]')?.textContent ?? '')) {
          state.rastersWhenCountShown = window.__pdfProbe.rasters.length;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__countWatch = state;
    });

    const started = Date.now();
    await uploadFiles(page, FIXTURE.pdf48page);
    await expect(page.getByTestId('split-page')).toHaveCount(48, { timeout: 30_000 });
    // Tag every card; a grid rebuilt as thumbnails arrive would replace them.
    await page.getByTestId('split-page').evaluateAll((cards) => cards.forEach((c) => ((c as HTMLElement).dataset.probe = 'kept')));
    await expect(thumbs(page)).toHaveCount(48, { timeout: 60_000 });
    const wallMs = Date.now() - started;
    await expectImageRendered(thumbs(page).last());

    const rastersWhenCountShown = await page.evaluate(() => {
      window.__countWatch!.stop();
      return window.__countWatch!.rastersWhenCountShown;
    });
    const p = await probe(page);
    testInfo.annotations.push({
      type: 'thumbnail-timing',
      description: `48 pages: all thumbnails ${wallMs}ms after upload, ${rastersWhenCountShown} pages rasterised when the count was shown`,
    });

    // The count is shown without waiting for the pages.
    expect(rastersWhenCountShown).not.toBeNull();
    expect(rastersWhenCountShown!).toBeLessThan(48);

    // Each page is rasterised exactly once, from one document.
    expect(p.rasters).toHaveLength(48);
    expect(p.opened).toBe(1);

    // No card was replaced while its thumbnail arrived.
    const kept = await page.locator('[data-testid="split-page"][data-probe="kept"]').count();
    expect(kept).toBe(48);
  });
});
