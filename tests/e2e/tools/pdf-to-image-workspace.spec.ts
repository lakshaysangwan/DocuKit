import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { assertImage, assertZip, expectDownload, pngSize, readZipEntries } from '../helpers/harness';
import {
  gridMarks,
  meanDifference,
  openOptions,
  openPdfToImage,
  openPreview,
  outputList,
  pressedPages,
} from '../helpers/pdf-to-image';

/**
 * PDF to Image in the workspace. Every promise the page makes before
 * converting — which pages, the file names, the pixel sizes, the enlarged
 * preview — is checked against the image files that are downloaded.
 */

const range = (page: Page) => page.getByLabel('Page range to convert');

async function setRange(page: Page, value: string) {
  await openOptions(page);
  if (!(await range(page).isVisible())) await page.getByRole('button', { name: 'Custom range' }).click();
  await range(page).fill(value);
}

async function chooseDpi(page: Page, dpi: number) {
  await openOptions(page);
  await page.getByRole('button', { name: new RegExp(`^${dpi} DPI`) }).click();
}

/** Convert, then take every image out through the ZIP (one download, any count). */
async function convertAndRead(page: Page): Promise<{ name: string; bytes: Buffer }[]> {
  await page.getByTestId('tool-action').click();
  const primary = page.getByTestId('download-button');
  await expect(primary).toBeVisible({ timeout: 90_000 });
  const zip = page.getByTestId('download-zip');
  if (await zip.count()) {
    const { bytes } = await expectDownload(page, () => zip.click());
    assertZip(bytes);
    return readZipEntries(bytes);
  }
  const { bytes, name } = await expectDownload(page, () => primary.click());
  return [{ name, bytes }];
}

async function closePreview(page: Page) {
  await page.getByTestId('page-preview-close').click();
  await expect(page.getByTestId('page-preview-dialog')).toHaveCount(0);
}

test.describe('PDF to Image — pages: the grid and the range field', () => {
  test('clicking pages rewrites the field, and the field (odd, even, last) drives the grid', async ({ page }) => {
    await openPdfToImage(page, FIXTURE.pdf5page, 5);
    // All pages to start with.
    expect(await pressedPages(page)).toEqual([1, 2, 3, 4, 5]);
    await expect(page.getByTestId('page-grid-caption')).toContainText('5 of 5 pages will be exported');

    // A click leaves a page out and switches to a custom range written from the grid.
    await page.getByTestId('page-select-1').click();
    await expect(range(page)).toHaveValue('1, 3-5');
    expect(await pressedPages(page)).toEqual([1, 3, 4, 5]);
    await page.getByTestId('page-select-1').click();
    await expect(range(page)).toHaveValue('1-5');

    for (const [value, want] of [
      ['odd', [1, 3, 5]],
      ['even', [2, 4]],
      ['last', [5]],
      ['1-2, last', [1, 2, 5]],
    ] as const) {
      await range(page).fill(value);
      await expect.poll(() => pressedPages(page)).toEqual(want);
    }

    // Shift-click selects the run of pages from the last one clicked.
    await range(page).fill('5');
    await page.getByTestId('page-select-0').click();
    await expect(range(page)).toHaveValue('1, 5');
    await page.getByTestId('page-select-2').click({ modifiers: ['Shift'] });
    await expect(range(page)).toHaveValue('1-3, 5');

    // The keyboard toggles a page too.
    await page.getByTestId('page-select-3').focus();
    await page.keyboard.press('Space');
    await expect(range(page)).toHaveValue('1-5');

    // A field that cannot be read is flagged and changes nothing.
    await range(page).fill('1-3');
    await range(page).fill('2-9');
    await expect(page.getByTestId('p2i-range-error')).toBeVisible();
    expect(await pressedPages(page)).toEqual([1, 2, 3]);
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toContainText('Fix the page field first');

    // "All pages" brings every page back.
    await page.getByRole('button', { name: 'All 5 pages' }).click();
    expect(await pressedPages(page)).toEqual([1, 2, 3, 4, 5]);
  });

  test('pages left out are dimmed and marked "Not exported", and are not delivered', async ({ page }) => {
    await openPdfToImage(page, FIXTURE.pdf5page, 5);
    await setRange(page, 'odd');
    await expect.poll(() => gridMarks(page)).toEqual(['Selected', 'Not exported', 'Selected', 'Not exported', 'Selected']);
    const cards = page.getByTestId('p2i-page');
    await expect(cards.nth(1)).toHaveAttribute('data-mark-state', 'dimmed');
    await expect(cards.nth(1).getByTestId('page-detail')).toHaveText('Not exported');
    await expect(cards.nth(2).getByTestId('page-detail')).toContainText('doc-5page-page-3.png');
    await expect(page.getByTestId('tool-action')).toHaveText('Convert 3 pages to PNG');

    const files = await convertAndRead(page);
    expect(files.map((f) => f.name)).toEqual(['doc-5page-page-1.png', 'doc-5page-page-3.png', 'doc-5page-page-5.png']);
  });
});

test.describe('PDF to Image — the output list is what is downloaded', () => {
  for (const dpi of [72, 150, 300]) {
    test(`at ${dpi} DPI the names and pixel sizes listed are the images delivered`, async ({ page }) => {
      test.slow();
      await openPdfToImage(page, FIXTURE.pdf5page, 5);
      await chooseDpi(page, dpi);
      await setRange(page, '1, 3, 5');
      const listed = await outputList(page);
      expect(listed.map((o) => o.name)).toEqual(['doc-5page-page-1.png', 'doc-5page-page-3.png', 'doc-5page-page-5.png']);
      await expect(page.locator('#p2i-outputs-title')).toHaveText("You'll get 3 images");

      const files = await convertAndRead(page);
      expect(files.map((f) => f.name)).toEqual(listed.map((o) => o.name));
      for (const [i, f] of files.entries()) {
        assertImage(f.bytes, 'png');
        expect(pngSize(f.bytes), f.name).toEqual({ width: listed[i].width, height: listed[i].height });
      }
      // Letter-size pages: the arithmetic, not only agreement with the page.
      expect(listed[0].width).toBe(Math.floor((612 * dpi) / 72));

      // After converting, each card shows the real size of its file.
      const metas = await page.getByTestId('result-meta').allTextContents();
      metas.forEach((m, i) => expect(m).toContain(`${listed[i].width} × ${listed[i].height} px`));
    });
  }
});

test.describe('PDF to Image — the enlarged page is the exported image', () => {
  for (const dpi of [150, 300]) {
    test(`at ${dpi} DPI, PNG: same pixel size and the same pixels as the downloaded file`, async ({ page }) => {
      test.slow();
      await openPdfToImage(page, FIXTURE.pdf5page, 5);
      await chooseDpi(page, dpi);
      const preview = await openPreview(page, 2, { format: 'png', dpi });
      const dialog = page.getByTestId('page-preview-dialog');
      await expect(dialog.getByTestId('p2i-preview-size')).toHaveText(`${preview.width} × ${preview.height} px`);
      await expect(dialog).toContainText('As saved: doc-5page-page-3.png');
      await expect(dialog.getByTestId('p2i-preview-capped')).toHaveCount(0);
      const bytesShown = ((await dialog.getByTestId('p2i-preview-bytes').textContent()) ?? '').trim();
      expect(bytesShown).toMatch(/^[\d.]+ (B|KB|MB)$/);

      // 100% means one image pixel per CSS pixel.
      await dialog.getByTestId('p2i-zoom-actual').click();
      const shown = await dialog.getByTestId('p2i-preview-image').evaluate((el) => el.getBoundingClientRect().width);
      expect(Math.round(shown)).toBe(preview.width);
      await dialog.getByTestId('p2i-zoom-fit').click();
      await closePreview(page);

      await setRange(page, '3');
      const [file] = await convertAndRead(page);
      expect(file.name).toBe('doc-5page-page-3.png');
      expect(pngSize(file.bytes)).toEqual({ width: preview.width, height: preview.height });
      const diff = await meanDifference(page, preview.bytes, file.bytes, 'image/png');
      expect(diff, 'mean difference per channel').toBeLessThan(1);
      // The same function, encoder and settings: the very same file.
      expect(preview.bytes.equals(file.bytes)).toBe(true);
      // The size the preview reported is the size of the file.
      await expect(page.getByTestId('result-meta')).toHaveText(`${preview.width} × ${preview.height} px · ${bytesShown}`);
      expect(file.bytes.length).toBe(preview.bytes.length);
    });
  }

  test('format and quality show in the preview, and its bytes are the downloaded JPEG', async ({ page }) => {
    test.slow();
    await openPdfToImage(page, FIXTURE.pdf3page, 3);
    await openOptions(page);
    await page.getByRole('button', { name: 'jpeg', exact: true }).click();
    await page.getByRole('button', { name: '72 DPI (screen)' }).click();
    const q85 = await openPreview(page, 0, { format: 'jpeg', dpi: 72, quality: 85 });
    expect(q85.type).toBe('image/jpeg');
    assertImage(q85.bytes, 'jpeg');
    const sizeText85 = await page.getByTestId('p2i-preview-bytes').textContent();
    await closePreview(page);

    await openOptions(page);
    await page.getByLabel('Quality').fill('20');
    const q20 = await openPreview(page, 0, { format: 'jpeg', dpi: 72, quality: 20 });
    expect(q20.bytes.length).toBeLessThan(q85.bytes.length);
    expect(await page.getByTestId('p2i-preview-bytes').textContent()).not.toBe(sizeText85);
    await closePreview(page);

    await openOptions(page);
    await page.getByRole('button', { name: 'webp', exact: true }).click();
    const webp = await openPreview(page, 0, { format: 'webp', dpi: 72, quality: 20 });
    assertImage(webp.bytes, 'webp');
    await closePreview(page);

    await openOptions(page);
    await page.getByRole('button', { name: 'jpeg', exact: true }).click();
    await setRange(page, '1');
    const [file] = await convertAndRead(page);
    expect(file.name).toBe('doc-3page-page-1.jpeg');
    assertImage(file.bytes, 'jpeg');
    expect(file.bytes.equals(q20.bytes), 'the JPEG previewed at quality 20 is the JPEG downloaded').toBe(true);

    // WebP downloads as WebP, and is the WebP previewed.
    await page.getByTestId('edit-again').click();
    await openOptions(page);
    await page.getByRole('button', { name: 'webp', exact: true }).click();
    const [webpFile] = await convertAndRead(page);
    expect(webpFile.name).toBe('doc-3page-page-1.webp');
    assertImage(webpFile.bytes, 'webp');
    expect(webpFile.bytes.equals(webp.bytes)).toBe(true);
  });

  test('at 600 DPI the preview is drawn smaller, says so, and still reports the size of the file', async ({ page }) => {
    test.slow();
    await openPdfToImage(page, FIXTURE.pdf1page, 1);
    await chooseDpi(page, 600);
    const listed = (await outputList(page))[0];
    const preview = await openPreview(page, 0, { format: 'png', dpi: 600 });
    const dialog = page.getByTestId('page-preview-dialog');
    await expect(dialog.getByTestId('p2i-preview-capped')).toContainText('to stay within this device');
    await expect(dialog.getByTestId('p2i-preview-size')).toHaveText(`${listed.width} × ${listed.height} px`);
    await expect(dialog.getByTestId('p2i-preview-bytes')).toContainText('(estimated)');
    const drawn = Number(await dialog.getByTestId('p2i-preview-image').getAttribute('data-drawn-dpi'));
    expect(drawn).toBeLessThan(600);
    expect(preview.width * preview.height).toBeLessThanOrEqual(12_000_000);
    expect(preview.width).toBe(Math.floor((612 * drawn) / 72));
    await closePreview(page);

    const [file] = await convertAndRead(page);
    expect(pngSize(file.bytes)).toEqual({ width: listed.width, height: listed.height });
  });
});

test.describe('PDF to Image — a result never outlives a change', () => {
  test('clicking a page or Make changes drops the images; converting again delivers the new choice', async ({ page }) => {
    await openPdfToImage(page, FIXTURE.pdf3page, 3);
    await chooseDpi(page, 72);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toHaveText('Download all (3 images)', { timeout: 45_000 });

    // A page click while the result is shown.
    await page.getByTestId('page-select-0').click();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('result-card')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toHaveText('Convert 2 pages to PNG');

    // Make changes.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toHaveText('Download all (2 images)', { timeout: 45_000 });
    await page.getByTestId('edit-again').click();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await openOptions(page);
    await page.getByRole('button', { name: 'avif', exact: true }).click();
    await expect(page.getByTestId('tool-action')).toHaveText('Convert 2 pages to AVIF');

    const files = await convertAndRead(page);
    expect(files.map((f) => f.name)).toEqual(['doc-3page-page-2.avif', 'doc-3page-page-3.avif']);
    for (const f of files) assertImage(f.bytes, 'avif');
  });
});
