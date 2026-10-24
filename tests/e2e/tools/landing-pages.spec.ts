import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { LANDING_PAGES } from '../../../src/lib/landing-pages';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertImage,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';
import { convertAndDownload, openConvert } from '../helpers/convert-image';
import { openOrganize, saveAndDownload, filePageOrder, fileRotations } from '../helpers/organize-pages';

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
  // Each Convert Image task page opens with its output format chosen.
  const CONVERT_PRESETS = [
    { slug: 'png-to-jpg', file: FIXTURE.png, format: 'jpeg', label: 'JPG' },
    { slug: 'jpg-to-png', file: FIXTURE.jpg, format: 'png', label: 'PNG' },
    { slug: 'webp-to-jpg', file: FIXTURE.webp, format: 'jpeg', label: 'JPG' },
    { slug: 'webp-to-png', file: FIXTURE.webp, format: 'png', label: 'PNG' },
    { slug: 'heic-to-jpg', file: FIXTURE.heic, format: 'jpeg', label: 'JPG' },
  ] as const;
  for (const preset of CONVERT_PRESETS) {
    test(`${preset.slug} starts on ${preset.label} and downloads one, without touching the format picker`, async ({ page }) => {
      await openConvert(page, preset.file, `/${preset.slug}/`);
      await expect(page.getByTestId(`format-${preset.format}`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('tool-action')).toHaveText(`Convert to ${preset.label}`);
      const { bytes, name } = await convertAndDownload(page);
      assertImage(bytes, preset.format);
      expect(name).toMatch(preset.format === 'jpeg' ? /.jpg$/ : /.png$/);
    });
  }

  test('PDF to JPG exports JPEG', async ({ page }) => {
    await page.goto('/pdf-to-jpg/');
    await addSingleFileAndWait(page, FIXTURE.pdf1page);
    await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByTestId('tool-action')).toHaveText('Convert 1 page to JPEG');

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
    // Each click is seen to land before the next, so a miss names the page it missed.
    await page.getByTestId('page-select-1').click();
    await expect(page.getByTestId('page-select-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('textbox')).toHaveValue('2');
    await page.getByTestId('page-select-3').click();
    await expect(page.getByTestId('page-select-3')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('textbox')).toHaveValue('2, 4');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toBe('doc-5page-split.pdf');
    expect(countPdfPages(bytes)).toBe(2);
  });

  test('Rotate PDF: "Rotate all right" and one page turned back — the file has those turns', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3, '/rotate-pdf/');
    await page.getByRole('button', { name: 'Rotate all right', exact: true }).click();
    await page.getByRole('button', { name: 'Rotate page 2 left', exact: true }).click();
    await expect(page.getByTestId('tool-action')).toHaveText('Save PDF (3 pages)');

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['1', '2', '3']);
    expect(await fileRotations(bytes)).toEqual([90, 0, 90]);
  });
});
