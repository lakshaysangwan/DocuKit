import { test, expect, type Locator, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import { makeMarkerGif } from '../fixtures/image-fixtures';
import { MARKER_COLOURS } from '../fixtures/sign-fixtures';
import { expectHeicPhotoOnPage } from '../helpers/heic-photo';
import { pageImages, renderPage, type Raster } from '../helpers/redact-pdf';
import { openWatermark, setSlider, watermarkAndDownload } from '../helpers/watermark';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

test.describe('Watermark PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/watermark-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Add Watermark to PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('applies a text watermark and preserves page count', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    // Default type is Text with "CONFIDENTIAL"; change the text and tweak sliders.
    await page.getByRole('textbox').first().fill('DRAFT COPY');
    await page.getByRole('button', { name: 'tiled' }).click();
    await page.getByRole('button', { name: 'odd pages' }).click();

    await page.getByTestId('tool-action').click();
    // The success text also appears in a toast, so key off the download button.
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-watermarked\.pdf$/);
    expect(countPdfPages(bytes)).toBe(5);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('image watermark mode accepts a logo and applies it', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    await page.getByRole('button', { name: 'image Watermark' }).click();
    // The image watermark dropzone is a second file input; upload a PNG logo.
    await page.locator('input[type="file"]').nth(1).setInputFiles(FIXTURE.png);

    await page.getByTestId('tool-action').click();
    // The success text also appears in a toast, so key off the download button.
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(3);
  });
});

/** The image watermark set up plainly: one copy, opaque, not turned, so its pixels can be read off the page. */
async function chooseWatermarkImage(page: Page, file: Parameters<Locator['setInputFiles']>[0], name: string) {
  await page.getByTestId('wm-type-image').click();
  await expect(page.getByTestId('wm-image-input')).toHaveAttribute('accept', /image\/heic.*\.heic/);
  await page.getByTestId('wm-image-input').setInputFiles(file);
  // HEIC is decoded by a WASM library where the browser cannot do it itself.
  await expect(page.getByTestId('wm-image-name')).toHaveText(name, { timeout: 60_000 });
  await page.getByTestId('wm-placement-single').click();
  await setSlider(page, 'wm-opacity', 100);
  await setSlider(page, 'wm-rotation', 0);
}

/** Mean colour of a small square of a raster around a point (fractions). */
function colourAt(r: Raster, x: number, y: number): number[] {
  const cx = Math.round(x * r.width);
  const cy = Math.round(y * r.height);
  const sum = [0, 0, 0];
  let n = 0;
  for (let j = cy - 3; j <= cy + 3; j++) {
    for (let i = cx - 3; i <= cx + 3; i++) {
      const at = (j * r.width + i) * 3;
      for (let c = 0; c < 3; c++) sum[c] += r.data[at + c];
      n++;
    }
  }
  return sum.map((s) => s / n);
}

test.describe('Watermark PDF — image types that are converted first', () => {
  test('an iPhone HEIC photo is the watermark, upright at its own size', async ({ page }) => {
    test.slow();
    const diag = new PageDiagnostics(page);
    await openWatermark(page, FIXTURE.pdf1page);
    await chooseWatermarkImage(page, FIXTURE.heic, 'photo.heic');
    await expect(page.getByTestId('wm-image-name').locator('xpath=..')).toContainText('Converted to JPEG for the PDF.');

    const bytes = await watermarkAndDownload(page);
    const placed = await expectHeicPhotoOnPage(bytes, 0);
    // Centred, half the page wide (the defaults).
    expect(placed.x + placed.width / 2).toBeCloseTo(0.5, 2);
    expect(placed.y + placed.height / 2).toBeCloseTo(0.5, 2);
    expect(placed.width).toBeCloseTo(0.5, 2);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('a GIF with transparency becomes a PNG watermark that keeps it', async ({ page }) => {
    await openWatermark(page, FIXTURE.pdf1page);
    const gif = makeMarkerGif({ transparentQuadrant: 'bottomRight' });
    await chooseWatermarkImage(page, { name: 'logo.gif', mimeType: 'image/gif', buffer: gif }, 'logo.gif');
    await expect(page.getByTestId('wm-image-name').locator('xpath=..')).toContainText('Converted to PNG for the PDF.');

    const bytes = await watermarkAndDownload(page);
    const images = await pageImages(bytes, 0);
    expect(images).toHaveLength(1);
    expect([images[0].raster.width, images[0].raster.height]).toEqual([240, 160]);
    // Stored as a PNG (Flate) with an alpha mask.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const xobjects = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const stored = xobjects
      .keys()
      .map((key) => xobjects.lookup(key))
      .filter((x): x is PDFRawStream => x instanceof PDFRawStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(stored).toHaveLength(1);
    expect(String(stored[0].dict.get(PDFName.of('Filter')))).toBe('/FlateDecode');
    expect(stored[0].dict.has(PDFName.of('SMask')), 'the image carries an alpha mask').toBe(true);

    // Rendered: three quadrants keep their colour, the see-through one shows the white page.
    const { bbox } = images[0];
    const rendered = await renderPage(bytes, 0, 2);
    const at = (u: number, v: number) => colourAt(rendered, bbox.x + bbox.width * u, bbox.y + bbox.height * v);
    const near = (got: number[], want: readonly number[], what: string) =>
      got.forEach((v, c) => expect(Math.abs(v - want[c]), `${what} channel ${c}: ${v.toFixed(0)} vs ${want[c]}`).toBeLessThanOrEqual(12));
    near(at(0.25, 0.25), MARKER_COLOURS.topLeft, 'top left');
    near(at(0.75, 0.25), MARKER_COLOURS.topRight, 'top right');
    near(at(0.25, 0.75), MARKER_COLOURS.bottomLeft, 'bottom left');
    near(at(0.75, 0.75), [255, 255, 255], 'transparent bottom right shows the page');
  });
});
