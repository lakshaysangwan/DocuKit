import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, expectImageRendered } from '../helpers/harness';

/**
 * The shared PDF document layer (src/lib/pdf) as the legacy thumbnail hook
 * exposes it today, in a real browser against the production build.
 *
 * The hook's last caller is Redact PDF, so that is the page driven here (PDF to
 * Image, which these tests used to drive, now draws its pages through the
 * document handle directly). Redact asks for 800px on the long edge and does
 * not print a page count, so those two checks are adapted; what is proven is
 * the same.
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
    __thumbCommits?: { commits: number[]; thumbsWhenCountShown: number | null; stop: () => void };
  }
}

/** How often usePdfThumbnails publishes to React state (THUMBNAIL_FLUSH_INTERVAL_MS). */
const FLUSH_INTERVAL_MS = 150;

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
const liveDocuments = async (page: Page) => {
  const p = await probe(page);
  return p.opened - p.terminated;
};
/** Redact's page images: the hook's thumbnails. */
const THUMB = '[data-testid="redact-page"] img';
const thumbs = (page: Page) => page.locator(THUMB);
const thumbSources = (page: Page) =>
  thumbs(page).evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src));

test.describe('PDF document layer behind the page thumbnails', () => {
  test('thumbnails are blob: images that really decode, from one document that is closed when they are done', async ({ page }) => {
    await installProbe(page);
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    const images = thumbs(page);
    await expect(images).toHaveCount(5, { timeout: 20_000 });
    for (let i = 0; i < 5; i++) {
      await expectImageRendered(images.nth(i));
      expect(await images.nth(i).getAttribute('src')).toMatch(/^blob:/);
      expect(await images.nth(i).getAttribute('alt')).toContain(`Page ${i + 1}`);
    }
    // 800px on the long edge of a portrait Letter page, as the tool asks for.
    const size = await images.first().evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
    expect(Math.max(...size)).toBe(800);

    // Nothing needs the pdf.js document once the last page is drawn.
    await expect.poll(() => liveDocuments(page), { timeout: 10_000 }).toBe(0);
    const p = await probe(page);
    expect(p.rasters).toHaveLength(5);
    expect(new Set(await thumbSources(page))).toEqual(new Set(p.rasters));
    expect(p.revoked.filter((url) => p.rasters.includes(url))).toEqual([]);
  });

  test('loading another file releases the previous file’s thumbnails', async ({ page }) => {
    await installProbe(page);
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(thumbs(page)).toHaveCount(3, { timeout: 20_000 });
    const first = await thumbSources(page);

    await page.getByRole('button', { name: 'Remove file' }).click();
    await expect(page.getByTestId('file-info')).toHaveCount(0);
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await expect(thumbs(page)).toHaveCount(5, { timeout: 20_000 });
    const second = await thumbSources(page);

    const p = await probe(page);
    for (const url of first) expect(p.revoked).toContain(url);
    for (const url of second) expect(p.revoked).not.toContain(url);
    await expectImageRendered(thumbs(page).first());
    await expect.poll(() => liveDocuments(page), { timeout: 10_000 }).toBe(0);
  });

  test('leaving the tool releases its thumbnails and leaves no document open', async ({ page }) => {
    await installProbe(page);
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await expect(thumbs(page)).toHaveCount(5, { timeout: 20_000 });
    const sources = await thumbSources(page);

    // Navigation is client-side (Astro's ClientRouter), so the page's JS — and
    // anything it leaked — would survive it. The probe surviving proves that.
    await page.locator('header a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    const p = await probe(page);
    expect(p.rasters.length, 'the document was not reloaded').toBeGreaterThanOrEqual(5);
    for (const url of sources) expect(p.revoked).toContain(url);
    expect(p.opened - p.terminated).toBe(0);
  });

  test('leaving while thumbnails are still rendering stops the work and releases everything', async ({ page }) => {
    await installProbe(page);
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf48page);
    await expect(thumbs(page).first()).toBeVisible({ timeout: 20_000 });

    await page.locator('header a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
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

  test('a 48-page PDF shows its first pages before the last is drawn, renders each page once, and publishes them in batches', async ({ page }, testInfo) => {
    await installProbe(page);
    await page.goto('/redact-pdf');
    await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible();

    // Count the DOM updates that add thumbnails: each is one React commit of
    // the list. Also note how many pages had been rasterised when the first
    // thumbnail appeared.
    await page.evaluate((selector) => {
      const state = { commits: [] as number[], thumbsWhenCountShown: null as number | null, stop: () => observer.disconnect() };
      const observer = new MutationObserver((records) => {
        const addedThumb = records.some((r) =>
          [...r.addedNodes].some((n) => n instanceof Element && (n.matches(selector) || !!n.querySelector(selector))),
        );
        if (addedThumb && state.thumbsWhenCountShown === null) state.thumbsWhenCountShown = window.__pdfProbe.rasters.length;
        if (addedThumb) state.commits.push(performance.now());
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__thumbCommits = state;
    }, THUMB);

    const started = Date.now();
    await addSingleFileAndWait(page, FIXTURE.pdf48page);
    await expect(thumbs(page)).toHaveCount(48, { timeout: 60_000 });
    const wallMs = Date.now() - started;
    await expectImageRendered(thumbs(page).last());

    const { commits, thumbsWhenCountShown } = await page.evaluate(() => {
      window.__thumbCommits!.stop();
      return window.__thumbCommits!;
    });
    const p = await probe(page);
    const spanMs = commits[commits.length - 1] - commits[0];
    testInfo.annotations.push({
      type: 'thumbnail-timing',
      description: `48 pages: ${commits.length} grid commits over ${Math.round(spanMs)}ms, all thumbnails ${wallMs}ms after upload, ${thumbsWhenCountShown} pages rasterised when the first thumbnail appeared`,
    });
    console.log(`[pdf-doc-layer] ${testInfo.project.name}: ${commits.length} commits, span ${Math.round(spanMs)}ms, all thumbnails after ${wallMs}ms, ${thumbsWhenCountShown} rasterised when first shown, ${p.rasters.length} rasters`);

    // The first pages are shown without waiting for the rest.
    expect(thumbsWhenCountShown).not.toBeNull();
    expect(thumbsWhenCountShown!).toBeLessThan(48);

    // Each page is rasterised exactly once — nothing is rendered twice.
    expect(p.rasters).toHaveLength(48);
    expect(p.opened).toBe(1);

    // The grid is not committed once per page: after the first thumbnail, at
    // most one commit per flush interval, however many pages arrive in it.
    expect(commits.length).toBeLessThanOrEqual(Math.ceil(spanMs / FLUSH_INTERVAL_MS) + 2);
  });
});
