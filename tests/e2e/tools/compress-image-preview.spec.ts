import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FIXTURE } from '../fixtures/generate';
import { assertImage, expectDownload, expectDownloads } from '../helpers/harness';
import {
  chooseFormat,
  compressImages,
  decodeImage,
  imageBytes,
  openCompressImage,
  openCompressImageBuffer,
  setQuality,
  setTarget,
  settledPreview,
  transparentPng,
} from '../helpers/compress-image';

/**
 * Compress Image in the workspace: what downloads is checked — its signature,
 * name, size and pixels — and the compare view is checked against it.
 */

const download = (page: import('@playwright/test').Page) =>
  expectDownload(page, () => page.getByTestId('download-button').click());

test.describe('Compress Image — the file that downloads', () => {
  test('normal path: WebP bytes, a .webp name, the same pixel size, and facts from the file', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    await settledPreview(page);
    await compressImages(page);
    const { bytes, name } = await download(page);
    assertImage(bytes, 'webp');
    expect(name).toBe('photo-compressed.webp');
    const decoded = await decodeImage(page, bytes);
    expect([decoded.width, decoded.height]).toEqual([1200, 800]);

    await expect(page.getByTestId('fact-format')).toHaveText('Format: WebP');
    await expect(page.getByTestId('fact-quality')).toHaveText('Quality: 75');
    await expect(page.getByTestId('fact-pixels')).toHaveText('Pixel size: 1200 × 800 px (unchanged)');
    const original = (await readFile(FIXTURE.jpg)).length;
    const pct = Math.round(((original - bytes.length) / original) * 100);
    await expect(page.getByTestId('fact-saved')).toHaveText(`Saved: ${pct}%`);
    await expect(page.getByTestId('fact-metadata')).toContainText('not carried over');
  });

  test('original returned: the download is the original, named and typed as the JPEG it is', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    // WebP at quality 100 is larger than this small JPEG, so the original comes back.
    await setQuality(page, 100);
    await settledPreview(page);
    await compressImages(page);
    await expect(page.getByTestId('fact-original')).toContainText('Your original is kept: as WebP at quality 100 it came to');
    await expect(page.getByTestId('fact-format')).toHaveText('Format: JPEG — your original file, unchanged.');
    await expect(page.getByTestId('step-prompt')).toContainText('your original is kept');
    const { bytes, name } = await download(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('photo-compressed.jpg');
    expect(bytes.equals(await readFile(FIXTURE.jpg)), 'the original bytes, unchanged').toBe(true);
  });

  test('Target size never uses PNG: a PNG choice becomes WebP, and the file is WebP', async ({ page }) => {
    await openCompressImage(page, FIXTURE.png);
    await chooseFormat(page, 'png');
    await expect(page.getByTestId('png-note')).toContainText('PNG is lossless');
    await expect(page.getByLabel('Quality', { exact: true })).toHaveCount(0);
    await setTarget(page, 200);
    await expect(page.getByTestId('format-png')).toBeDisabled();
    await expect(page.getByTestId('format-webp')).toHaveAttribute('aria-pressed', 'true');
    await compressImages(page);
    const { bytes, name } = await download(page);
    assertImage(bytes, 'webp');
    expect(name).toBe('graphic-compressed.webp');
    expect(bytes.length).toBeLessThanOrEqual(200 * 1024);
  });

  test('a transparent PNG saved as JPEG is white where it was transparent — in the file and in the preview', async ({ page }) => {
    await page.goto('/compress-image');
    const png = await transparentPng(page);
    await openCompressImageBuffer(page, { name: 'logo.png', mimeType: 'image/png', buffer: png });
    await chooseFormat(page, 'jpeg');
    await expect(page.getByTestId('jpeg-background-note')).toHaveText('JPEG cannot store transparency: transparent areas become white.');
    await settledPreview(page);
    const shown = await imageBytes(page, 'compare-after');
    await compressImages(page);
    await expect(page.getByTestId('fact-background')).toHaveText(
      'Transparent areas are filled with white, because JPEG cannot store transparency.',
    );
    const { bytes, name } = await download(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('logo-compressed.jpg');
    expect(shown.equals(bytes), 'the preview is the file').toBe(true);
    const { at } = await decodeImage(page, bytes, [[20, 80], [60, 20], [200, 80]]);
    for (const px of at.slice(0, 2)) for (const c of px.slice(0, 3)) expect(c, `transparent area ${px}`).toBeGreaterThanOrEqual(245);
    expect(at[2][0], 'opaque area stays red').toBeGreaterThan(180);
    expect(at[2][1]).toBeLessThan(70);
  });

  test('Target size hit: under the limit, with the quality it needed', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    await chooseFormat(page, 'jpeg');
    await setTarget(page, 10);
    await expect(page.getByTestId('stage-status')).toContainText('Target size shows the result after you press Compress image');
    await compressImages(page);
    const { bytes, name } = await download(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('photo-compressed.jpg');
    expect(bytes.length).toBeLessThanOrEqual(10 * 1024);
    await expect(page.getByTestId('fact-quality')).toHaveText(/^Quality \d+ was needed to fit under 10 KB\.$/);
    // And the compare view shows that file.
    expect((await imageBytes(page, 'compare-after')).equals(bytes)).toBe(true);
  });

  test('Target size missed: reported, with the smallest size reached, which is the file', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    await chooseFormat(page, 'jpeg');
    await setTarget(page, 1);
    await compressImages(page);
    await expect(page.getByTestId('step-prompt')).toContainText('could not be brought under 1 KB');
    const missed = page.getByTestId('fact-target-missed');
    await expect(missed).toContainText('Could not get under 1 KB: the smallest this image gets is');
    await expect(missed).toContainText('as JPEG at quality 5');
    const { bytes } = await download(page);
    assertImage(bytes, 'jpeg');
    expect(bytes.length).toBeGreaterThan(1024);
    const kb = Number(/gets is ([\d.]+) KB/.exec((await missed.textContent()) ?? '')?.[1]);
    expect(Math.abs(kb - bytes.length / 1024), 'the size reported is the file').toBeLessThan(0.06);
  });

  test('quality 20 is smaller than quality 80, and the compare view shows the downloaded file', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg2);
    await chooseFormat(page, 'jpeg');
    const sizes: Record<number, number> = {};
    for (const q of [20, 80]) {
      await setQuality(page, q);
      await settledPreview(page);
      await expect(page.getByTestId('stage-status')).toContainText(`JPEG at quality ${q}`);
      await compressImages(page);
      const { bytes } = await download(page);
      assertImage(bytes, 'jpeg');
      expect((await imageBytes(page, 'compare-after')).equals(bytes), `q${q}: compare view = file`).toBe(true);
      await expect(page.getByTestId('fact-quality')).toHaveText(`Quality: ${q}`);
      sizes[q] = bytes.length;
      await page.getByTestId('edit-again').click();
    }
    expect(sizes[20]).toBeLessThan(sizes[80]);
  });

  test('live update settles on the last slider value', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    await expect(page.getByTestId('stage-status')).toHaveAttribute('data-live', 'true');
    for (const q of [30, 55, 10, 90, 42]) await setQuality(page, q);
    await settledPreview(page);
    await expect(page.getByTestId('stage-status')).toContainText('WebP at quality 42');
    await expect(page.getByTestId('preview-facts').getByTestId('fact-quality')).toHaveText('Quality: 42');
    const shown = await imageBytes(page, 'compare-after');
    await compressImages(page);
    const { bytes } = await download(page);
    expect(shown.equals(bytes), 'the live preview is the file').toBe(true);
  });

  test('AVIF waits for Preview, then shows it', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    await chooseFormat(page, 'avif');
    const status = page.getByTestId('stage-status');
    await expect(status).toHaveAttribute('data-live', 'false');
    await expect(status).toHaveAttribute('data-preview', 'waiting');
    await expect(page.getByTestId('compare-after')).toHaveCount(0);
    await page.getByTestId('preview-quality').click();
    await settledPreview(page);
    await expect(status).toContainText('AVIF at quality 75');
  });

  test('batch of 3: one image at a time on the stage, facts for each, separate downloads', async ({ page }) => {
    await openCompressImage(page, [FIXTURE.jpg, FIXTURE.jpg2, FIXTURE.png]);
    await expect(page.getByTestId('image-strip-item')).toHaveCount(3);
    await expect(page.getByTestId('tool-action')).toHaveText('Compress 3 images');
    await page.getByTestId('image-strip-item').nth(1).click();
    await expect(page.getByTestId('image-stage')).toHaveAttribute('data-selected', '1');
    await compressImages(page);

    await expect(page.getByTestId('batch-fact')).toHaveCount(3);
    await expect(page.getByTestId('multi-download')).toBeVisible();
    await expect(page.getByTestId('facts-heading')).toContainText('photo-2-compressed.webp');
    await page.getByTestId('image-strip-item').nth(2).click();
    await expect(page.getByTestId('facts-heading')).toContainText('graphic-compressed.webp');
    await expect(page.getByTestId('fact-pixels')).toHaveText('Pixel size: 800 × 800 px (unchanged)');

    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 3);
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['graphic-compressed.webp', 'photo-2-compressed.webp', 'photo-compressed.webp']);
    for (const f of files) assertImage(f.bytes, 'webp');
    const sizes = await Promise.all(files.map((f) => decodeImage(page, f.bytes)));
    expect(sizes.map((s) => `${s.width}x${s.height}`).sort()).toEqual(['1200x800', '800x800', '900x1200']);
  });

  test('100% shows one image pixel per CSS pixel', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    await page.getByTestId('compare-zoom-100').click();
    await expect(page.getByTestId('compare-view')).toHaveAttribute('data-zoom', '1');
    const box = (await page.getByTestId('compare-before').boundingBox())!;
    expect(Math.abs(box.width - 1200)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - 800)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-backdrop="checkerboard"]').first()).toBeAttached();
  });

  test('EXIF is gone from a re-encoded JPEG', async ({ page }) => {
    const original = await readFile(FIXTURE.jpgExif);
    expect(original.toString('latin1'), 'fixture must carry EXIF').toContain('Exif\0\0');
    await openCompressImage(page, FIXTURE.jpgExif);
    await chooseFormat(page, 'jpeg');
    await setQuality(page, 60);
    await settledPreview(page);
    await compressImages(page);
    await expect(page.getByTestId('fact-original')).toHaveCount(0);
    const { bytes } = await download(page);
    assertImage(bytes, 'jpeg');
    expect(bytes.toString('latin1')).not.toContain('Exif\0\0');
    expect(bytes.toString('latin1')).not.toContain('GPSLatitude');
  });

  test('any change after a run drops the result', async ({ page }) => {
    await openCompressImage(page, FIXTURE.jpg);
    await compressImages(page);
    // A different file, chosen from the bar while the result is shown.
    await page.getByTestId('change-file-input').setInputFiles(FIXTURE.jpg2);
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('file-info')).toHaveAttribute('data-filename', 'photo-2.jpg');
    await expect(page.getByTestId('tool-action')).toBeEnabled();
  });
});
