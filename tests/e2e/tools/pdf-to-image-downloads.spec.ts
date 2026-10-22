import { test, expect, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import {
  addSingleFileAndWait,
  uploadBuffer,
  expectDownload,
  expectDownloads,
  expectImageRendered,
  readZipEntries,
  pngSize,
  assertZip,
  assertImage,
} from '../helpers/harness';
import { openOptions } from '../helpers/pdf-to-image';

/**
 * PDF to Image — getting the images out without a ZIP.
 *
 * Every assertion about delivery reads the delivered files (download events,
 * ZIP entries, bytes handed to a stubbed folder or share sheet), because the
 * point of the feature is what lands on disk, not what the buttons say.
 *
 * What these cannot show: the permission prompt a real browser may put in front
 * of the second automatic download (Chrome's "download multiple files", Safari's
 * per-site prompt). Automation grants downloads silently, so a pass here means
 * the page *starts* the right downloads, not that every browser keeps them.
 */

const NAME_3 = (n: number) => `doc-3page-page-${n}.png`;

async function convert(page: Page, opts: { file?: string; range?: string; dpi72?: boolean } = {}) {
  await page.goto('/pdf-to-image');
  await addSingleFileAndWait(page, opts.file ?? FIXTURE.pdf3page);
  await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
  if (opts.dpi72) await page.getByRole('button', { name: '72 DPI (screen)' }).click();
  if (opts.range) {
    await page.getByRole('button', { name: 'Custom range' }).click();
    await page.getByLabel('Page range to convert').fill(opts.range);
  }
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
}

/** A PDF with `pages` numbered pages, built in memory — the fixtures stop at five. */
async function makeNumberedPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([300, 200]).drawText(`Sheet ${i + 1}`, { x: 30, y: 100, size: 40, font });
  }
  return Buffer.from(await doc.save());
}

async function convertBuffer(page: Page, pages: number, range?: string) {
  await page.goto('/pdf-to-image');
  await uploadBuffer(page, { name: 'big-report.pdf', mimeType: 'application/pdf', buffer: await makeNumberedPdf(pages) });
  await expect(page.getByTestId('file-info')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
  await page.getByRole('button', { name: '72 DPI (screen)' }).click();
  if (range) {
    await page.getByRole('button', { name: 'Custom range' }).click();
    await page.getByLabel('Page range to convert').fill(range);
  }
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
}

/** Top edge in document coordinates, so scrolling does not read as movement. */
const docTop = (locator: Locator) =>
  locator.evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));

const cardNames = (page: Page) => page.getByTestId('result-name').allTextContents();

test.describe('PDF to Image — result gallery and single image', () => {
  test('one page: the primary button downloads the image itself and no ZIP is offered', async ({ page }) => {
    await convert(page, { range: '2' });

    await expect(page.getByTestId('multi-download')).toHaveAttribute('data-mode', 'single');
    const primary = page.getByTestId('download-button');
    await expect(primary).toHaveText('Download image');
    await expect(primary).toHaveAccessibleName(`Download image ${NAME_3(2)}`);
    await expect(page.getByTestId('download-zip')).toHaveCount(0);
    await expect(page.getByTestId('save-to-folder')).toHaveCount(0);
    await expect(page.getByTestId('result-card')).toHaveCount(1);

    const [file] = await expectDownloads(page, () => primary.click(), 1);
    assertImage(file.bytes, 'png');
    expect(file.name).toBe(NAME_3(2));
  });

  test('several pages: one card per image in page order, with a real thumbnail, name, pixel size and file size', async ({ page }) => {
    await convert(page);

    await expect(page.getByTestId('result-card')).toHaveCount(3);
    expect(await cardNames(page)).toEqual([NAME_3(1), NAME_3(2), NAME_3(3)]);
    await expect(page.getByRole('region', { name: 'Converted images' })).toContainText('3 images ready');

    // The thumbnail is the output blob itself (a blob: URL), decoded for real.
    const thumbs = page.getByTestId('result-thumb');
    await expect(thumbs).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await thumbs.nth(i).scrollIntoViewIfNeeded();
      await expectImageRendered(thumbs.nth(i));
      expect(await thumbs.nth(i).getAttribute('src')).toMatch(/^blob:/);
    }

    // Each card's own button downloads that page only, and the size printed on
    // the card is the size of the file that arrives.
    const second = page.getByTestId('result-card').nth(1);
    const button = second.getByRole('button', { name: `Download ${NAME_3(2)}` });
    const { bytes, name } = await expectDownload(page, () => button.click());
    expect(name).toBe(NAME_3(2));
    assertImage(bytes, 'png');
    const { width, height } = pngSize(bytes);
    await expect(second.getByTestId('result-meta')).toContainText(`${width} × ${height} px`);
    await expect(second.getByTestId('result-meta')).toHaveText(/px · [\d.]+ (B|KB|MB)$/);
    await expect(page.getByTestId('download-status')).toHaveText(`Download started: ${NAME_3(2)}.`);
  });
});

test.describe('PDF to Image — several images', () => {
  test('"Download all" starts one download per image, each a valid PNG under its page name', async ({ page }) => {
    await convert(page);

    await expect(page.getByTestId('multi-download')).toHaveAttribute('data-mode', 'direct');
    const primary = page.getByTestId('download-button');
    await expect(primary).toHaveText('Download all (3 images)');
    await expect(page.getByTestId('download-zip')).toBeVisible();
    await expect(page.getByTestId('download-helper')).toContainText('Your browser may ask once to allow several downloads');
    await expect(page.getByTestId('download-helper')).toContainText('Download as ZIP gives you everything in one file');

    const files = await expectDownloads(page, () => primary.click(), 3);
    expect(files.map((f) => f.name).sort()).toEqual([NAME_3(1), NAME_3(2), NAME_3(3)]);
    for (const f of files) assertImage(f.bytes, 'png');
    // Three different pages, not one page three times.
    expect(new Set(files.map((f) => f.bytes.toString('base64'))).size).toBe(3);

    // The page reports what it started and where to go if the browser kept fewer.
    await expect(page.getByTestId('download-status')).toHaveText(
      'Started 3 downloads. If fewer than 3 arrived, your browser blocked the rest — use Download as ZIP.',
    );
  });

  test('"Download as ZIP" is still one click away and its entries carry the page names', async ({ page }) => {
    await convert(page);

    const zipButton = page.getByTestId('download-zip');
    await expect(zipButton).toHaveText('Download as ZIP');
    await expect(zipButton).toHaveAccessibleName('Download as ZIP: doc-3page-images.zip');
    const { bytes, name } = await expectDownload(page, () => zipButton.click());
    expect(name).toBe('doc-3page-images.zip');
    assertZip(bytes);
    const entries = await readZipEntries(bytes);
    expect(entries.map((e) => e.name)).toEqual([NAME_3(1), NAME_3(2), NAME_3(3)]);
    for (const e of entries) assertImage(e.bytes, 'png');
  });

  test('a non-contiguous selection is named by source page, in the cards, the downloads and the ZIP', async ({ page }) => {
    await convert(page, { file: FIXTURE.pdf5page, range: '1, 3, 5' });
    const expected = [1, 3, 5].map((n) => `doc-5page-page-${n}.png`);

    expect(await cardNames(page)).toEqual(expected);
    await expect(page.getByTestId('result-card').locator('p').filter({ hasText: /^Page \d$/ })).toHaveText(['Page 1', 'Page 3', 'Page 5']);

    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 3);
    expect(files.map((f) => f.name).sort()).toEqual(expected);

    const zip = await expectDownload(page, () => page.getByTestId('download-zip').click());
    const entries = await readZipEntries(zip.bytes);
    expect(entries.map((e) => e.name)).toEqual(expected);

    // The file called page-3 really is page 3: converting page 3 alone gives
    // the same bytes (the encoder is deterministic).
    const fromSelection = files.find((f) => f.name === expected[1])!;
    // The options are behind Make changes once the images are ready.
    await page.getByTestId('edit-again').click();
    await page.getByLabel('Page range to convert').fill('3');
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toHaveText('Download image', { timeout: 45_000 });
    const alone = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect(alone.name).toBe(expected[1]);
    expect(alone.bytes.equals(fromSelection.bytes), 'page-3 from the selection equals page 3 converted alone').toBe(true);
  });

  test('ten images is still "Download all", and all ten arrive with zero-padded names', async ({ page }) => {
    test.slow();
    await convertBuffer(page, 12, '1-10');
    const expected = Array.from({ length: 10 }, (_, i) => `big-report-page-${String(i + 1).padStart(2, '0')}.png`);

    await expect(page.getByTestId('download-button')).toHaveText('Download all (10 images)');
    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 10);
    expect(files.map((f) => f.name).sort()).toEqual(expected);
    for (const f of files) assertImage(f.bytes, 'png');
  });

  test('above ten images the ZIP is the primary, "Download all" is gone, and every card keeps its button', async ({ page }) => {
    test.slow();
    await convertBuffer(page, 12);
    const expected = Array.from({ length: 12 }, (_, i) => `big-report-page-${String(i + 1).padStart(2, '0')}.png`);

    await expect(page.getByTestId('multi-download')).toHaveAttribute('data-mode', 'zip');
    const primary = page.getByTestId('download-button');
    await expect(primary).toHaveText('Download ZIP (12 images)');
    await expect(page.getByRole('button', { name: /Download all/ })).toHaveCount(0);
    await expect(page.getByTestId('download-zip')).toHaveCount(0);
    await expect(page.getByTestId('download-helper')).toContainText('so they come as one ZIP');

    const { bytes } = await expectDownload(page, () => primary.click());
    assertZip(bytes);
    expect((await readZipEntries(bytes)).map((e) => e.name)).toEqual(expected);

    await expect(page.getByTestId('result-download')).toHaveCount(12);
    const eleventh = await expectDownload(page, () =>
      page.getByRole('button', { name: `Download ${expected[10]}` }).click());
    expect(eleventh.name).toBe(expected[10]);
    assertImage(eleventh.bytes, 'png');
  });
});

test.describe('PDF to Image — save to a folder', () => {
  test('the option is not shown where the browser has no folder access', async ({ page }) => {
    await page.addInitScript(() => {
      try { delete (window as any).showDirectoryPicker; } catch {}
      if ('showDirectoryPicker' in window) Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    });
    await convert(page);
    await expect(page.getByTestId('download-zip')).toBeVisible();
    await expect(page.getByTestId('save-to-folder')).toHaveCount(0);
  });

  test('writes every image into the picked folder and reports the count; cancel and write errors are reported too', async ({ page }) => {
    // The real picker is a native dialog automation cannot drive, so the API is
    // replaced with a recording stand-in that follows the same contract.
    await page.addInitScript(() => {
      const w = window as any;
      w.__picker = { mode: 'ok', written: [] as { name: string; size: number; head: number[] }[], options: null };
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async (options: unknown) => {
          w.__picker.options = options;
          if (w.__picker.mode === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError');
          return {
            name: 'Exports',
            getFileHandle: async (name: string) => ({
              createWritable: async () => {
                let blob: Blob | null = null;
                return {
                  write: async (data: Blob) => {
                    if (w.__picker.mode === 'fail-second' && name.includes('page-2')) throw new DOMException('No space', 'QuotaExceededError');
                    blob = data;
                  },
                  close: async () => {
                    const bytes = new Uint8Array(await blob!.arrayBuffer());
                    w.__picker.written.push({ name, size: bytes.length, head: Array.from(bytes.slice(0, 8)) });
                  },
                };
              },
            }),
          };
        },
      });
    });
    await convert(page);
    const button = page.getByTestId('save-to-folder');
    const status = page.getByTestId('download-status');
    await expect(button).toHaveText('Save to a folder…');

    await button.click();
    await expect(status).toHaveText('3 images saved to Exports.');
    const written = await page.evaluate(() => (window as any).__picker.written);
    expect(written.map((f: any) => f.name)).toEqual([NAME_3(1), NAME_3(2), NAME_3(3)]);
    for (const f of written) {
      expect(Buffer.from(f.head).toString('latin1'), `${f.name} is a PNG`).toBe('\x89PNG\r\n\x1a\n');
      expect(f.size).toBeGreaterThan(100);
    }
    expect(await page.evaluate(() => (window as any).__picker.options.mode)).toBe('readwrite');

    await page.evaluate(() => { (window as any).__picker.mode = 'cancel'; });
    await button.click();
    await expect(status).toHaveText('No folder was chosen, so nothing was saved.');

    await page.evaluate(() => { (window as any).__picker.mode = 'fail-second'; (window as any).__picker.written = []; });
    await button.click();
    await expect(status).toHaveText('2 of 3 images saved to Exports. 1 could not be written — use Download as ZIP for the rest.');
    expect(await page.evaluate(() => (window as any).__picker.written.map((f: any) => f.name))).toEqual([NAME_3(1), NAME_3(3)]);
  });
});

test.describe('PDF to Image — share sheet', () => {
  const stubShare = (page: Page, canShare: boolean) =>
    page.addInitScript((can) => {
      const w = window as any;
      w.__share = { cancel: false, calls: [] as { name: string; type: string; size: number }[][] };
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: any) => can && Array.isArray(data?.files) });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: { files: File[] }) => {
          if (w.__share.cancel) throw new DOMException('Share canceled', 'AbortError');
          w.__share.calls.push(data.files.map((f) => ({ name: f.name, type: f.type, size: f.size })));
        },
      });
    }, canShare);

  test('is not offered when the browser cannot share files', async ({ page }) => {
    await stubShare(page, false);
    await convert(page);
    await expect(page.getByTestId('download-zip')).toBeVisible();
    await expect(page.getByTestId('share-files')).toHaveCount(0);
  });

  test('is offered when the browser can share files, and hands over every image', async ({ page }) => {
    await stubShare(page, true);
    await convert(page);
    const button = page.getByTestId('share-files');
    const status = page.getByTestId('download-status');
    await expect(button).toHaveText('Share or save images…');

    await button.click();
    await expect(status).toHaveText('3 images handed to the share sheet.');
    const calls = await page.evaluate(() => (window as any).__share.calls);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((f: any) => f.name)).toEqual([NAME_3(1), NAME_3(2), NAME_3(3)]);
    for (const f of calls[0]) {
      expect(f.type).toBe('image/png');
      expect(f.size).toBeGreaterThan(100);
    }

    // Closing the sheet is not an error and nothing is claimed.
    await page.evaluate(() => { (window as any).__share.cancel = true; });
    await button.click();
    await expect(status).toHaveText('Sharing was cancelled, so nothing was sent.');
    // The other routes are still there to fall back on.
    await expect(page.getByTestId('download-button')).toBeEnabled();
    await expect(page.getByTestId('download-zip')).toBeEnabled();
  });
});

test.describe('PDF to Image — layout, memory and accessibility of the result', () => {
  for (const width of [1280, 375]) {
    test(`at ${width}px the buttons do not move when the result or a status message appears`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/pdf-to-image');
      await addSingleFileAndWait(page, FIXTURE.pdf3page);
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled({ timeout: 20_000 });
      // Thumbnails of the source pages load in the document pane; wait for them
      // so only movement caused by the *result* is measured.
      await expect(page.getByTestId('page-selector').getByTestId('p2i-page-image')).toHaveCount(3);
      const before = await docTop(action);

      await action.click();
      const primary = page.getByTestId('download-button');
      await expect(primary).toBeVisible({ timeout: 45_000 });
      // The download takes the Convert button's place in the action slot.
      expect(await docTop(primary), 'the download where Convert was').toBe(before);
      // On a phone the result is in the Options panel.
      await openOptions(page);
      await expect(page.getByTestId('result-card')).toHaveCount(3);

      // A status message arriving must not move the buttons or the cards.
      const firstCardButton = page.getByTestId('result-download').first();
      const zip = page.getByTestId('download-zip');
      const y = { primary: await docTop(primary), zip: await docTop(zip), card: await docTop(firstCardButton) };
      await expectDownloads(page, () => primary.click(), 3);
      await expect(page.getByTestId('download-status')).toContainText('Started 3 downloads');
      expect({ primary: await docTop(primary), zip: await docTop(zip), card: await docTop(firstCardButton) }).toEqual(y);

      // Nothing overflows sideways, at phone width in particular.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
    });
  }

  test('thumbnail object URLs are revoked when the result is cleared', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any;
      w.__revoked = [] as string[];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url: string) => { w.__revoked.push(url); revoke(url); };
    });
    await convert(page);
    const thumbs = page.getByTestId('result-thumb');
    await expect(thumbs).toHaveCount(3);
    const srcs = await thumbs.evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src));
    expect(srcs.every((s) => s.startsWith('blob:'))).toBe(true);
    expect(await page.evaluate((s) => s.filter((u) => (window as any).__revoked.includes(u)), srcs)).toEqual([]);

    await page.getByRole('button', { name: 'Remove file' }).click();
    await expect(page.getByTestId('result-card')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((s) => s.every((u) => (window as any).__revoked.includes(u)), srcs))
      .toBe(true);
  });

  test('axe finds no serious or critical violation with the gallery open, light and dark', async ({ page }) => {
    const scan = async () => {
      // The "Converted 3 pages" toast is transient and not part of the result;
      // scan the settled page (axe grades a toast mid-fade as low contrast).
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
    };
    await convert(page);
    await expectDownloads(page, () => page.getByTestId('download-button').click(), 3);
    await expect(page.getByTestId('download-status')).toContainText('Started 3 downloads');
    await expect(page.getByTestId('download-button')).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    expect(await scan()).toEqual([]);

    await page.addInitScript(() => localStorage.setItem('docukit-theme', 'dark'));
    await convert(page);
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await scan()).toEqual([]);
  });

  test('results are announced in a live region and every button names what it acts on', async ({ page }) => {
    await convert(page);
    const status = page.getByTestId('download-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveText('');

    for (const n of [1, 2, 3]) {
      await expect(page.getByRole('button', { name: `Download ${NAME_3(n)}`, exact: true })).toHaveCount(1);
    }
    await expect(page.getByRole('button', { name: 'Download all (3 images)' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Download as ZIP: doc-3page-images.zip' })).toHaveCount(1);
    for (const n of [1, 2, 3]) {
      await expect(page.getByRole('img', { name: `Preview of ${NAME_3(n)}` })).toHaveCount(1);
    }
  });

  test('focus lands on the download after converting, and the options and each card follow in order', async ({ page, browserName }) => {
    // Safari does not Tab to buttons unless the user turns that on, and
    // Playwright's WebKit follows it — the order is asserted where Tab applies.
    test.skip(browserName === 'webkit', 'WebKit skips buttons on Tab by default');
    await page.addInitScript(() => {
      // Pin the optional routes off so the expected order is the same everywhere.
      try { delete (window as any).showDirectoryPicker; } catch {}
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    });
    await convert(page);
    const focusedId = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute('aria-label') ?? el?.dataset.testid ?? el?.tagName ?? '';
    });
    // The Convert button is replaced by the download, and focus goes with it.
    await expect(page.getByTestId('download-button')).toBeFocused();

    await page.getByTestId('download-zip').focus();
    const order: string[] = [await focusedId()];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      order.push(await focusedId());
    }
    expect(order).toEqual([
      'Download as ZIP: doc-3page-images.zip',
      `Download ${NAME_3(1)}`,
      `Download ${NAME_3(2)}`,
      `Download ${NAME_3(3)}`,
    ]);
  });
});
