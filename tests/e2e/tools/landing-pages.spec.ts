import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { LANDING_PAGES } from '../../../src/lib/landing-pages';
import {
  PageDiagnostics,
  addFilesAndWait,
  addSingleFileAndWait,
  expectDownload,
  assertImage,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

/**
 * Task landing pages are existing tools opened with a preset. Two things can
 * go wrong that the base tool's own spec would not notice: the page itself
 * (heading, canonical, share image), and the preset not actually being applied.
 */
test.describe('Landing pages — every page renders', () => {
  for (const landing of LANDING_PAGES) {
    test(`/${landing.slug}/ loads with its own heading, canonical and share image`, async ({ page, request }) => {
      const diag = new PageDiagnostics(page);
      await page.goto(`/${landing.slug}/`);

      await expect(page.getByRole('heading', { level: 1 })).toHaveText(landing.h1);
      await expect(page).toHaveTitle(landing.pageTitle);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://docukit.uk/${landing.slug}/`);
      await expect(page.getByTestId('dropzone')).toBeVisible();

      const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
      const res = await request.get(new URL(ogImage!).pathname);
      expect(res.headers()['content-type']).toContain('image/png');

      expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
    });
  }

  test('a base tool page links to its task pages, and they link back', async ({ page }) => {
    await page.goto('/convert-image/');
    const tasks = page.getByRole('region', { name: 'Popular tasks' });
    await expect(tasks.getByRole('link', { name: 'PNG to JPG' })).toHaveAttribute('href', '/png-to-jpg/');

    await page.goto('/png-to-jpg/');
    await expect(page.getByRole('region', { name: 'Related tools' }).getByRole('link', { name: /Convert Image/ }))
      .toHaveAttribute('href', '/convert-image/');
  });
});

test.describe('Landing pages — the preset is applied', () => {
  test('PNG to JPG converts to JPEG without touching the format picker', async ({ page }) => {
    await page.goto('/png-to-jpg/');
    await addFilesAndWait(page, FIXTURE.png, 1);
    await expect(page.getByTestId('tool-action')).toContainText('to JPG');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
    expect(name).toMatch(/\.jpe?g$/);
  });

  test('WebP to PNG converts to PNG', async ({ page }) => {
    await page.goto('/webp-to-png/');
    await addFilesAndWait(page, FIXTURE.webp, 1);
    await expect(page.getByTestId('tool-action')).toContainText('to PNG');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'png');
  });

  test('HEIC to JPG converts a real iPhone-format photo', async ({ page }) => {
    await page.goto('/heic-to-jpg/');
    await addFilesAndWait(page, FIXTURE.heic, 1);
    await expect(page.getByTestId('tool-action')).toContainText('to JPG');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
  });

  test('PDF to JPG exports JPEG', async ({ page }) => {
    await page.goto('/pdf-to-jpg/');
    await addSingleFileAndWait(page, FIXTURE.pdf1page);
    await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByTestId('tool-action')).toHaveText('Convert to JPEG');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
  });

  test('Compress Image to 100KB starts in target-size mode and delivers a JPG under the limit', async ({ page }) => {
    await page.goto('/compress-image-to-100kb/');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expect(page.getByLabel('Target Size (KB)')).toHaveValue('100');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
    expect(bytes.byteLength).toBeLessThanOrEqual(100 * 1024);
  });

  test('Compress Image to 50KB presets 50', async ({ page }) => {
    await page.goto('/compress-image-to-50kb/');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expect(page.getByLabel('Target Size (KB)')).toHaveValue('50');
  });

  test('Compress PDF to 100KB starts in Target size mode at 100 KB and delivers a PDF under it', async ({ page }) => {
    await page.goto('/compress-pdf-to-100kb/');
    await addSingleFileAndWait(page, FIXTURE.pdfPhoto);
    await expect(page.getByLabel('Make the PDF no larger than')).toHaveValue('100');
    await expect(page.getByLabel('Size unit')).toHaveValue('KB');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(bytes.byteLength).toBeLessThanOrEqual(100 * 1024);
  });

  test('Compress PDF to 1MB presets the limit as 1 MB, not 1024 KB', async ({ page }) => {
    await page.goto('/compress-pdf-to-1mb/');
    await addSingleFileAndWait(page, FIXTURE.pdfPhoto);
    await expect(page.getByLabel('Make the PDF no larger than')).toHaveValue('1');
    await expect(page.getByLabel('Size unit')).toHaveValue('MB');
  });

  test('Delete PDF Pages opens in Remove mode: listed pages are dropped, the rest kept', async ({ page }) => {
    await page.goto('/delete-pdf-pages/');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await expect(page.getByTestId('split-modes').getByRole('button', { name: /^Remove Pages/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('textbox').fill('2, 4');
    // The grid shows the pages that will go.
    await expect(page.locator('[data-testid="split-page"][data-mark="Removed"]')).toHaveCount(2);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toBe('doc-5page-split.pdf');
    expect(countPdfPages(bytes)).toBe(3);
  });

  test('Extract PDF Pages opens in Extract mode: the pages clicked are the pages delivered', async ({ page }) => {
    await page.goto('/extract-pdf-pages/');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await expect(page.getByTestId('split-modes').getByRole('button', { name: /^Extract Pages/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('page-select-1').click();
    await page.getByTestId('page-select-3').click();
    await expect(page.getByRole('textbox')).toHaveValue('2, 4');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toBe('doc-5page-split.pdf');
    expect(countPdfPages(bytes)).toBe(2);
  });
});
