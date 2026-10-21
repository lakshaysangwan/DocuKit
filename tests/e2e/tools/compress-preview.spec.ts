import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FIXTURE } from '../fixtures/generate';
import { expectDownload, expectImageRendered } from '../helpers/harness';
import {
  afterPixels,
  chooseLevel,
  comparePixels,
  compressAndCompare,
  meanDiff,
  meanLuma,
  openCompress,
} from '../helpers/compress-pdf';

/**
 * Compress PDF shows the quality of what it made, page by page.
 *
 * Everything is measured on pixels the visitor sees — the two images of the
 * compare view — and on the downloaded file. FIXTURE.pdfPhoto is four Letter
 * pages, each one full-page JPEG and no text.
 */

test.describe.configure({ timeout: 120_000 });

async function setTarget(page: Page, kb: number, unit: 'KB' | 'MB' = 'KB') {
  await chooseLevel(page, 'Target size');
  await page.getByLabel('Make the PDF no larger than').fill(String(kb));
  await page.getByLabel('Size unit').selectOption(unit);
}

/** Compress at a level and return the compare view's pixel difference and the download. */
async function runAt(page: Page, level: string) {
  await openCompress(page, FIXTURE.pdfPhoto);
  await chooseLevel(page, level);
  await compressAndCompare(page);
  const { before, after } = await comparePixels(page);
  const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
  return { diff: meanDiff(before, after), bytes, before, after };
}

test.describe('Compress PDF — the result, compared page by page', () => {
  test('pixel and size proof: Low changes nothing, Medium something, High more; High < Medium < original', async ({ page }) => {
    const original = (await readFile(FIXTURE.pdfPhoto)).length;
    const low = await runAt(page, 'Low');
    const medium = await runAt(page, 'Medium');
    const high = await runAt(page, 'High');

    expect(low.diff, 'Low: the output page is pixel-identical to the original').toBe(0);
    expect(medium.diff, 'Medium: images are re-encoded, so pixels change').toBeGreaterThan(0);
    expect(high.diff, 'High changes the page more than Medium').toBeGreaterThan(medium.diff);

    expect(medium.bytes.length).toBeLessThan(original);
    expect(high.bytes.length).toBeLessThan(medium.bytes.length);
    // Still the same picture: no level makes the page dark.
    for (const r of [low, medium, high]) expect(Math.abs(meanLuma(r.after) - meanLuma(r.before))).toBeLessThan(10);
  });

  test('the facts come from the run: settings used, images on this page, no selectable text', async ({ page }) => {
    await openCompress(page, FIXTURE.pdfPhoto);
    await chooseLevel(page, 'High');
    await compressAndCompare(page);
    const facts = page.getByTestId('quality-facts');
    await expect(facts).toContainText('Result for page 1');
    await expect(facts).toContainText(
      'The image on this page is re-encoded at JPEG quality 50, scaled to 48% of its width and height.',
    );
    await expect(facts).toContainText('Text and vector graphics are not changed; document properties are cleared.');
    await expect(facts).toContainText('This page has no selectable text');
    await expect(page.getByTestId('page-image-bytes')).toHaveText(/^Images on this page: [\d.]+ KB → [\d.]+ KB$/);
    await expect(facts).not.toContainText(/DPI/i);
    await expect(page.getByTestId('preview-status')).toContainText('Result for page 1 · Images on this page:');
    // The result is the file's: nothing about the whole file's size before a run.
    await expect(page.getByText(/Before: /)).toBeVisible();
    await expect(page.getByTestId('download-button')).toHaveText(/Download PDF/);
  });

  test('Low says images are not re-encoded; a page with text is not called textless', async ({ page }) => {
    await openCompress(page, FIXTURE.pdf3page);
    await chooseLevel(page, 'Low');
    await compressAndCompare(page);
    const facts = page.getByTestId('quality-facts');
    await expect(facts).toContainText('Images are not re-encoded; document properties are cleared.');
    await expect(facts).not.toContainText('selectable text');
  });

  test('any page: changing page changes both images and the facts follow', async ({ page }) => {
    await openCompress(page, FIXTURE.pdfPhoto);
    await chooseLevel(page, 'High');
    await compressAndCompare(page);
    const first = await comparePixels(page);

    await page.getByTestId('page-next').click();
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 2 of 4');
    await expect(page.getByTestId('quality-facts')).toContainText('Result for page 2');
    await expect.poll(async () => (await comparePixels(page)).before.src).not.toBe(first.before.src);
    const second = await comparePixels(page);
    // Page 2 is a different photo, so its original looks different from page 1's.
    expect(meanDiff(first.before, second.before)).toBeGreaterThan(5);
    expect(second.before.src).not.toBe(second.after.src);

    // The rail goes straight to a page too.
    await page.getByTestId('rail-page-4').click();
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 4 of 4');
  });

  test('never cropped; Fit, 100% and 200% zoom; split, side by side and hold', async ({ page }) => {
    await openCompress(page, FIXTURE.pdfPhoto);
    await compressAndCompare(page);
    const before = page.getByTestId('compare-before');
    const after = page.getByTestId('compare-after');

    // Fit: the whole page, in its own proportions (Letter, 8.5 × 11).
    const fit = (await before.boundingBox())!;
    expect(fit.width / fit.height).toBeCloseTo(8.5 / 11, 2);
    const viewport = (await page.getByTestId('compare-viewport').boundingBox())!;
    expect(fit.height).toBeLessThanOrEqual(viewport.height);
    expect(await before.evaluate((el) => getComputedStyle(el).objectFit)).toBe('contain');

    // 100% is 96 CSS pixels per inch; 200% twice that. Both images the same size.
    await page.getByTestId('compare-zoom-100').click();
    await expect.poll(async () => Math.round((await before.boundingBox())!.width)).toBe(816);
    await page.getByTestId('compare-zoom-200').click();
    await expect.poll(async () => Math.round((await before.boundingBox())!.width)).toBe(1632);
    expect(Math.round((await after.boundingBox())!.width)).toBe(1632);
    await expect(page.getByTestId('compare-view')).toHaveAttribute('data-zoom', '2');
    await page.getByTestId('compare-zoom-fit').click();

    // Split: the divider moves with the keyboard, and the clip follows it.
    const divider = page.getByTestId('compare-divider');
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    const clipAt = () => after.evaluate((el) => getComputedStyle(el).clipPath);
    const clip50 = await clipAt();
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '40');
    expect(await clipAt()).not.toBe(clip50);
    await page.keyboard.press('Home');
    await expect(divider).toHaveAttribute('aria-valuenow', '0');
    expect(await clipAt()).toMatch(/inset\(0px 0px 0px 0px\)|inset\(0px\)/);

    // Side by side: the two next to each other, the original on the left.
    await page.getByTestId('compare-mode-side').click();
    await expect(page.getByTestId('compress-preview').locator('img')).toHaveCount(2);
    const left = (await before.boundingBox())!;
    const right = (await after.boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x + left.width - 1);
    expect(Math.abs(right.y - left.y)).toBeLessThan(1);

    // Hold: the result, and the original while the button is held.
    await page.getByTestId('compare-mode-hold').click();
    const hold = page.getByTestId('compare-hold');
    expect(await clipAt()).toMatch(/inset\(0px\)|inset\(0px 0px 0px 0px\)/);
    await hold.focus();
    await page.keyboard.down('Space');
    await expect(hold).toHaveAttribute('aria-pressed', 'true');
    expect(await clipAt()).toMatch(/100%/);
    await page.keyboard.up('Space');
    await expect(hold).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Compress PDF — Target size says what it took', () => {
  test('a tight target: what it took, and a warning at the harsh end', async ({ page }) => {
    // 8 KB takes the fixture to quality 40 at half its width and height — the
    // harsh end; 12 KB stops short of it (quality 50 at 60%) and is not warned about.
    await openCompress(page, FIXTURE.pdfPhoto);
    await setTarget(page, 8);
    await compressAndCompare(page);
    await expect(page.getByTestId('target-applied')).toHaveText(
      /^To fit under 8 KB, images were set to JPEG quality \d+ at \d+% of their width and height\.$/,
    );
    await expect(page.getByTestId('quality-warning')).toContainText('harsh end');
    await expect(page.getByTestId('target-missed')).toHaveCount(0);

    await page.getByTestId('edit-again').click();
    await setTarget(page, 12);
    await compressAndCompare(page);
    await expect(page.getByTestId('target-applied')).toHaveText(/^To fit under 12 KB, images were set to JPEG quality/);
    await expect(page.getByTestId('quality-warning')).toHaveCount(0);
  });

  test('a loose target: neither', async ({ page }) => {
    await openCompress(page, FIXTURE.pdfPhoto);
    await setTarget(page, 1, 'MB');
    await compressAndCompare(page);
    await expect(page.getByTestId('quality-facts')).toBeVisible();
    await expect(page.getByTestId('target-applied')).toHaveCount(0);
    await expect(page.getByTestId('quality-warning')).toHaveCount(0);
  });

  test('a target out of reach is stated in the KB the site uses, with what it took', async ({ page }) => {
    await openCompress(page, FIXTURE.pdfPhoto);
    await setTarget(page, 1);
    await compressAndCompare(page);
    await expect(page.getByTestId('target-missed')).toContainText('could not be brought under 1 KB');
    await expect(page.getByTestId('target-applied')).toHaveText(
      'To come as close as possible to 1 KB, images were set to JPEG quality 25 at 25% of their width and height.',
    );
    await expect(page.getByTestId('quality-warning')).toBeVisible();
    await expect(page.getByTestId('next-step')).toContainText('Split PDF');
  });
});

test.describe('Compress PDF — a page that comes out badly wrong is caught', () => {
  test('no warning at High or at the harshest target on a normal document', async ({ page }) => {
    await openCompress(page, FIXTURE.pdfPhoto);
    await chooseLevel(page, 'High');
    await compressAndCompare(page);
    // Every page of four is checked: the one shown, then first, last and middle.
    await expect(page.getByTestId('check-summary')).toContainText('pages 1, 2, 3 and 4 — none did.', { timeout: 30_000 });
    await expect(page.getByTestId('corruption-warning')).toHaveCount(0);
    await expect(page.getByTestId('download-button')).toHaveAttribute('data-variant', 'primary');

    await page.getByTestId('edit-again').click();
    await setTarget(page, 1); // out of reach: the harshest step is what is delivered
    await compressAndCompare(page);
    await expect(page.getByTestId('check-summary')).toContainText('none did.', { timeout: 30_000 });
    await expect(page.getByTestId('corruption-warning')).toHaveCount(0);
  });

  /**
   * A deliberately broken encoder. With OffscreenCanvas hidden from the page,
   * compression runs on the main thread (as it does on engines without it), so
   * the page's `createImageBitmap` is the one the compressor decodes each JPEG
   * with. Stubbed to hand back a black bitmap of the right size for exactly
   * that call (a JPEG blob with `colorSpaceConversion: 'none'`), every re-encoded
   * image comes out black — the failure the owner once saw for real.
   */
  test('a stubbed encoder that blackens images: warned, and the download demoted', async ({ page }) => {
    await page.addInitScript(() => {
      // @ts-expect-error — hiding it on purpose
      delete window.OffscreenCanvas;
      const real = window.createImageBitmap.bind(window);
      window.createImageBitmap = (async (source: ImageBitmapSource, ...rest: unknown[]) => {
        const options = rest[rest.length - 1] as ImageBitmapOptions | undefined;
        if (source instanceof Blob && source.type === 'image/jpeg' && options?.colorSpaceConversion === 'none') {
          const decoded = await real(source);
          const canvas = document.createElement('canvas');
          canvas.width = decoded.width;
          canvas.height = decoded.height;
          canvas.getContext('2d')!.fillRect(0, 0, decoded.width, decoded.height);
          decoded.close();
          return real(canvas);
        }
        // @ts-expect-error — passing the other overloads straight through
        return real(source, ...rest);
      }) as typeof window.createImageBitmap;
    });

    await openCompress(page, FIXTURE.pdfPhoto);
    await chooseLevel(page, 'High');
    await compressAndCompare(page);
    // The output really is black where the photo was…
    expect(meanLuma(await afterPixels(page))).toBeLessThan(30);
    // …and the visitor is told, on the stage, in the prompt and on the rail.
    const warning = page.getByTestId('corruption-warning');
    await expect(warning).toBeVisible({ timeout: 30_000 });
    await expect(warning).toContainText(/looks? badly wrong after compressing/);
    await expect(page.getByTestId('step-prompt')).toContainText('looks badly wrong');
    await expect(page.getByTestId('rail-warning-1')).toBeVisible();
    // The download is still there, demoted to "Download anyway".
    const download = page.getByTestId('download-button');
    await expect(download).toHaveText(/Download anyway/);
    await expect(download).toHaveAttribute('data-variant', 'outline');
    await expect(page.getByTestId('check-summary')).toContainText('did.');
    const { bytes } = await expectDownload(page, () => download.click());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

test('the page is shown large before a run, and is the original', async ({ page }) => {
  await openCompress(page, FIXTURE.pdfPhoto);
  await expect(page.getByTestId('compare-view')).toHaveAttribute('data-mode', /single|split/);
  await expectImageRendered(page.getByTestId('compare-before'));
  await expect(page.getByTestId('download-button')).toHaveCount(0);
  await expect(page.getByTestId('preview-status')).not.toBeEmpty();
});
