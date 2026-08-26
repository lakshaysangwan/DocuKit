import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  countPdfPagesStrict,
  extractPdfText,
} from '../helpers/harness';

/**
 * Drag a rectangle near the top of a redact-page element. The rendered page is
 * taller than the viewport, so we scroll it into view and keep the drag within
 * a small band near the top so the coordinates stay on-screen.
 */
async function drawMark(page: import('@playwright/test').Page, pageEl = 0) {
  const el = page.getByTestId('redact-page').nth(pageEl);
  await expect(el.locator('img')).toBeVisible();
  await expect.poll(async () => (await el.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error('redact page has no bounding box');
  const x1 = box.x + box.width * 0.2;
  const y1 = box.y + box.height * 0.06;
  const x2 = box.x + box.width * 0.6;
  const y2 = box.y + box.height * 0.18;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  // Small pauses let React commit drawStart and re-bind the mouseup handler.
  await page.waitForTimeout(120);
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 });
  await page.waitForTimeout(60);
  await page.mouse.move(x2, y2, { steps: 5 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

/**
 * Drag a full-width band across a page, from yTop% to yBottom% of its height.
 * Used to fully cover known lines of text for the true-redaction assertion.
 */
async function drawBand(
  page: import('@playwright/test').Page,
  pageEl: number,
  yTopPct: number,
  yBottomPct: number,
) {
  const el = page.getByTestId('redact-page').nth(pageEl);
  await expect(el.locator('img')).toBeVisible();
  await expect.poll(async () => (await el.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error('redact page has no bounding box');
  const x1 = box.x + box.width * 0.03;
  const x2 = box.x + box.width * 0.97;
  const y1 = box.y + box.height * yTopPct;
  const y2 = box.y + box.height * yBottomPct;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 });
  await page.waitForTimeout(60);
  await page.mouse.move(x2, y2, { steps: 5 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

test.describe('Redact PDF', () => {
  // The full-resolution page preview is tall; a tall viewport keeps the drag
  // target on-screen.
  test.use({ viewport: { width: 1280, height: 2200 } });

  test('page loads with H1 and permanent-redaction warning', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/redact-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Redact PDF');
    await expect(page.getByText('Redaction is permanent and irreversible', { exact: true })).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('draws a redaction mark, confirms, and produces a redacted PDF', async ({ page }) => {
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    // Page overlays render for drawing.
    await expect(page.getByTestId('redact-page').first()).toBeVisible({ timeout: 20_000 });
    await drawMark(page, 0);
    await expect(page.getByText(/area(s)? marked for redaction/)).toBeVisible();

    // Apply is gated on the confirmation checkbox.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await page.getByRole('checkbox').check();
    await expect(page.getByTestId('tool-action')).toBeEnabled();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-redacted\.pdf$/);
    // Redacted output keeps the same page count.
    expect(await countPdfPagesStrict(bytes)).toBe(3);
  });

  test('true redaction: removes marked text but keeps the rest of the text layer', async ({ page }) => {
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('redact-page').first()).toBeVisible({ timeout: 20_000 });

    // Sanity: the source really contains both the target and the survivor text.
    const original = await extractPdfText(await (await import('node:fs/promises')).readFile(FIXTURE.pdf3page));
    expect(original).toContain('Test Document');
    expect(original).toContain('sample body text');

    // Redact the top band (title + "Page 1 of 3") but not the body text below it.
    await drawBand(page, 0, 0.06, 0.2);
    await expect(page.getByText(/area(s)? marked for redaction/)).toBeVisible();
    await page.getByRole('checkbox').check();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);

    // Inspect only page 1 (that's where the mark was drawn).
    const page1 = await extractPdfText(bytes, 0);
    // The output still has a real, selectable text layer (not rasterized)…
    expect(page1.trim().length, 'output must retain a text layer').toBeGreaterThan(0);
    // …the body text on page 1 survives…
    expect(page1, 'non-redacted text must remain').toContain('sample body text');
    // …and the redacted title is physically gone from page 1.
    expect(page1, 'redacted text must be removed').not.toContain('Test Document');

    // Untouched pages keep their content, proving this is per-region — not a
    // whole-document rasterization.
    const page2 = await extractPdfText(bytes, 1);
    expect(page2, 'other pages are untouched').toContain('Test Document');
  });

  test('Find & Redact auto-marks every match; SHA-256 panel proves the file changed', async ({ page }) => {
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('redact-page').first()).toBeVisible({ timeout: 20_000 });

    // Search for a phrase that appears on every page and auto-mark all matches.
    await page.getByTestId('redact-search').fill('Test Document');
    await page.getByTestId('redact-find').click();
    await expect(page.getByText(/area(s)? marked for redaction/)).toBeVisible();

    await page.getByRole('checkbox').check();
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());

    // Every "Test Document" is gone across all pages; body text survives.
    const text = await extractPdfText(bytes);
    expect(text).not.toContain('Test Document');
    expect(text).toContain('sample body text');

    // The SHA-256 panel shows distinct before/after digests.
    await expect(page.getByTestId('sha-panel')).toBeVisible();
    const before = await page.getByTestId('sha-before').innerText();
    const after = await page.getByTestId('sha-after').innerText();
    expect(before).toHaveLength(64);
    expect(after).toHaveLength(64);
    expect(before).not.toBe(after);
  });

  test('a mark can be removed before applying', async ({ page }) => {
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('redact-page').first()).toBeVisible({ timeout: 20_000 });

    await drawMark(page, 0);
    await expect(page.getByText(/1 area marked/)).toBeVisible();
    await page.getByRole('button', { name: 'Remove mark' }).click();
    // With no marks, the confirmation + apply controls disappear.
    await expect(page.getByTestId('tool-action')).toHaveCount(0);
  });
});
