import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  assertImage,
  assertZip,
  expectDownload,
  expectDownloads,
  readZipEntries,
} from '../helpers/harness';
import {
  convertAndDownload,
  decodeImage,
  halvesBmp,
  imageBytes,
  isBlue,
  isClear,
  isRed,
  isWhite,
  openConvert,
  openConvertBuffer,
  pickFormat,
  setQuality,
  settledPreview,
  transparentPng,
} from '../helpers/convert-image';

/**
 * Convert Image in the workspace. Every test reads the file that downloads:
 * its magic bytes, its name, the pixel size it decodes to and, where it
 * matters, its pixels.
 */

test.describe('Convert Image', () => {
  test('page loads with its heading and dropzone, and opens in the workspace', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/convert-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Convert Image Format');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    await openConvert(page, FIXTURE.jpg, '/convert-image');
    await expect(page.getByTestId('image-stage')).toBeVisible();
    await expect(page.getByTestId('file-info')).toContainText('1200 × 800 px');
    await expect(page.getByTestId('step-prompt')).not.toBeEmpty();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('JPG → PNG: a lossless PNG named .png, same pixels size, no quality slider', async ({ page }) => {
    await openConvert(page, FIXTURE.jpg);
    await pickFormat(page, 'png');
    await expect(page.getByLabel('Quality', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toHaveText('Convert to PNG');

    const { bytes, name } = await convertAndDownload(page);
    assertImage(bytes, 'png');
    expect(name).toBe('photo.png');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([1200, 800]);
    await expect(page.getByTestId('fact-format')).toHaveText('Format: JPEG → PNG');
    await expect(page.getByTestId('fact-quality')).toContainText('lossless');
    await expect(page.getByTestId('fact-pixels')).toContainText('1200 × 800 px');
    await expect(page.getByTestId('image-stage')).toHaveAttribute('data-comparing', 'true');
  });

  test('a transparent PNG → JPG: transparent areas become white, and the page says so', async ({ page }) => {
    await page.goto('/convert-image');
    const png = await transparentPng(page);
    await openConvertBuffer(page, { name: 'cutout.png', mimeType: 'image/png', buffer: png });
    await pickFormat(page, 'jpeg');
    await expect(page.getByTestId('format-note')).toContainText('transparent areas become white');

    const { bytes, name } = await convertAndDownload(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('cutout.jpg');
    const img = await decodeImage(page, bytes, [[20, 80], [200, 80]]);
    expect([img.width, img.height]).toEqual([240, 160]);
    expect(isWhite(img.at[0]), `left (was transparent): ${img.at[0]}`).toBe(true);
    expect(isRed(img.at[1]), `right: ${img.at[1]}`).toBe(true);
    await expect(page.getByTestId('fact-transparency')).toHaveText(
      'Transparent areas are filled with white, because JPEG cannot store transparency.',
    );
  });

  for (const format of ['png', 'webp'] as const) {
    test(`a transparent PNG → ${format.toUpperCase()} keeps its transparency`, async ({ page }) => {
      await page.goto('/convert-image');
      const png = await transparentPng(page);
      await openConvertBuffer(page, { name: 'cutout.png', mimeType: 'image/png', buffer: png });
      await pickFormat(page, format);
      const { bytes, name } = await convertAndDownload(page);
      assertImage(bytes, format);
      expect(name).toBe(`cutout.${format}`);
      const img = await decodeImage(page, bytes, [[20, 80], [200, 80]]);
      expect(isClear(img.at[0]), `left stays transparent: ${img.at[0]}`).toBe(true);
      expect(isRed(img.at[1]), `right: ${img.at[1]}`).toBe(true);
      await expect(page.getByTestId('fact-transparency')).toContainText('Transparency kept');
    });
  }

  test('JPG and WebP preview live: the compared image is the file that downloads, and quality changes it', async ({ page }) => {
    await openConvert(page, FIXTURE.png);
    await pickFormat(page, 'jpeg');
    await expect(page.getByTestId('stage-status')).toHaveAttribute('data-live', 'true');
    await setQuality(page, 30);
    await settledPreview(page);
    const low = await imageBytes(page, 'compare-after');
    assertImage(low, 'jpeg');
    await expect(page.getByTestId('preview-facts').getByTestId('fact-quality')).toHaveText('Quality: 30');

    await setQuality(page, 95);
    await expect(page.getByTestId('preview-facts').getByTestId('fact-quality')).toHaveText('Quality: 95', { timeout: 60_000 });
    await settledPreview(page);
    const high = await imageBytes(page, 'compare-after');
    expect(high.byteLength).toBeGreaterThan(low.byteLength);

    const { bytes, name } = await convertAndDownload(page);
    expect(name).toBe('graphic.jpg');
    expect(bytes.equals(high), 'the download is the previewed file').toBe(true);
    await expect(page.getByTestId('fact-quality')).toHaveText('Quality: 95');
  });

  test('AVIF waits for Preview, then downloads a real AVIF', async ({ page }) => {
    await openConvert(page, FIXTURE.png);
    await pickFormat(page, 'avif');
    const status = page.getByTestId('stage-status');
    await expect(status).toHaveAttribute('data-live', 'false');
    await expect(status).toHaveAttribute('data-preview', 'waiting');
    await page.getByTestId('preview-convert').click();
    await expect(status).toHaveAttribute('data-preview', 'ready', { timeout: 90_000 });

    const { bytes, name } = await convertAndDownload(page);
    assertImage(bytes, 'avif');
    expect(name).toBe('graphic.avif');
    await expect(page.getByTestId('fact-format')).toHaveText('Format: PNG → AVIF');
  });

  test('a sideways phone photo comes out upright, without its EXIF', async ({ page }) => {
    await openConvert(page, FIXTURE.jpgRotated); // stored 1200×800, EXIF 6, shown 800×1200
    await expect(page.getByTestId('file-info')).toContainText('800 × 1200 px');
    await pickFormat(page, 'webp');
    const { bytes, name } = await convertAndDownload(page);
    assertImage(bytes, 'webp');
    expect(name).toBe('photo-rotated.webp');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([800, 1200]);
    expect(bytes.includes(Buffer.from('Exif', 'latin1'))).toBe(false);
  });

  test('a BMP is read and converted', async ({ page }) => {
    await page.goto('/convert-image');
    await openConvertBuffer(page, { name: 'scan.bmp', mimeType: 'image/bmp', buffer: halvesBmp(64, 40) });
    await pickFormat(page, 'png');
    const { bytes, name } = await convertAndDownload(page);
    assertImage(bytes, 'png');
    expect(name).toBe('scan.png');
    const img = await decodeImage(page, bytes, [[10, 20], [54, 20]]);
    expect([img.width, img.height]).toEqual([64, 40]);
    expect(isRed(img.at[0]), `left: ${img.at[0]}`).toBe(true);
    expect(isBlue(img.at[1]), `right: ${img.at[1]}`).toBe(true);
    await expect(page.getByTestId('fact-format')).toHaveText('Format: BMP → PNG');
  });

  test('batch: a strip of images, then separate downloads or one ZIP', async ({ page }) => {
    await openConvert(page, [FIXTURE.jpg, FIXTURE.png]);
    await expect(page.getByTestId('image-strip-item')).toHaveCount(2);
    await expect(page.getByTestId('file-info')).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('tool-action')).toHaveText('Convert 2 images to WebP');
    await page.getByTestId('image-strip-item').nth(1).click();
    await expect(page.getByTestId('image-stage')).toHaveAttribute('data-selected', '1');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('batch-fact')).toHaveCount(2);
    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 2);
    expect(files.map((f) => f.name).sort()).toEqual(['graphic.webp', 'photo.webp']);
    const sizes: Record<string, number[]> = { 'photo.webp': [1200, 800], 'graphic.webp': [800, 800] };
    for (const f of files) {
      assertImage(f.bytes, 'webp');
      const img = await decodeImage(page, f.bytes);
      expect([img.width, img.height]).toEqual(sizes[f.name]);
    }

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-zip').click());
    assertZip(bytes);
    expect(name).toBe('converted-images.zip');
    const entries = await readZipEntries(bytes);
    expect(entries.map((e) => e.name).sort()).toEqual(['graphic.webp', 'photo.webp']);
    for (const e of entries) assertImage(e.bytes, 'webp');
  });

  test('two images that would get the same name are both kept', async ({ page }) => {
    await page.goto('/convert-image');
    // photo.jpg and a PNG also called photo: both become photo.jpg.
    const png = await transparentPng(page);
    await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible();
    await page.locator('input[type="file"]').first().setInputFiles([
      { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await readFile(FIXTURE.jpg) },
      { name: 'photo.png', mimeType: 'image/png', buffer: png },
    ]);
    await expect(page.getByTestId('image-strip-item')).toHaveCount(2);
    await pickFormat(page, 'jpeg');
    await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 2);
    expect(files.map((f) => f.name).sort()).toEqual(['photo (2).jpg', 'photo.jpg']);
    for (const f of files) assertImage(f.bytes, 'jpeg');
  });

  test('Make changes goes back to the options, and a new format gives a new file', async ({ page }) => {
    await openConvert(page, FIXTURE.webp);
    await pickFormat(page, 'png');
    let { bytes } = await convertAndDownload(page);
    assertImage(bytes, 'png');
    await page.getByRole('button', { name: 'Make changes' }).click();
    await expect(page.getByTestId('tool-action')).toBeVisible();
    await pickFormat(page, 'jpeg');
    ({ bytes } = await convertAndDownload(page));
    assertImage(bytes, 'jpeg');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([1000, 700]);
  });
});

/**
 * HEIC is the one accepted input no browser decodes natively, so it goes
 * through libheif (heic-to). That path is the first thing a stricter
 * Content-Security-Policy breaks — heic-to's default build evaluates a string
 * as script — which is why these run against a real HEVC-coded file.
 */
test.describe('Convert Image — HEIC (iPhone) input', () => {
  test('HEIC is shown on the stage, and → JPG produces a JPEG of its pixels', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await openConvert(page, FIXTURE.heic);
    await expect(page.getByTestId('file-info')).toContainText('600 × 400 px');
    await pickFormat(page, 'jpeg');
    const { bytes, name } = await convertAndDownload(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('photo.jpg');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([600, 400]);
    await expect(page.getByTestId('fact-format')).toHaveText('Format: HEIC → JPEG');
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('HEIC → PNG produces a valid PNG', async ({ page }) => {
    await openConvert(page, FIXTURE.heic);
    await pickFormat(page, 'png');
    const { bytes, name } = await convertAndDownload(page);
    assertImage(bytes, 'png');
    expect(name).toBe('photo.png');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([600, 400]);
  });
});
