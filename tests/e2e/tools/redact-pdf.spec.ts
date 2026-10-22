import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  expectDownload,
  assertPdf,
  countPdfPagesStrict,
  extractPdfText,
} from '../helpers/harness';
import { drawMark, openOptions, openRedact } from '../helpers/redact-pdf';

/** A mark near the top of page 1, over the title. */
const MARK = { x: 0.2, y: 0.06, width: 0.4, height: 0.12 };

test.describe('Redact PDF', () => {
  test('page loads with H1 and permanent-redaction warning', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/redact-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Redact PDF');
    await expect(page.getByText('Redaction is permanent and irreversible', { exact: true })).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('draws a redaction mark, confirms, and produces a redacted PDF', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);

    await drawMark(page, MARK);
    await openOptions(page);
    await expect(page.getByText(/area(s)? marked for redaction/)).toBeVisible();

    // Apply is gated on the confirmation checkbox, and says so.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Tick the confirmation to redact');
    await page.getByTestId('confirm-redaction').check();
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
    await openRedact(page, FIXTURE.pdf3page);

    // Sanity: the source really contains both the target and the survivor text.
    const original = await extractPdfText(await (await import('node:fs/promises')).readFile(FIXTURE.pdf3page));
    expect(original).toContain('Test Document');
    expect(original).toContain('sample body text');

    // Redact the top band (title + "Page 1 of 3") but not the body text below it.
    await drawMark(page, { x: 0.03, y: 0.06, width: 0.94, height: 0.14 });
    await openOptions(page);
    await expect(page.getByText(/area(s)? marked for redaction/)).toBeVisible();
    await page.getByTestId('confirm-redaction').check();

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
    await openRedact(page, FIXTURE.pdf3page);
    await openOptions(page);

    // Search for a phrase that appears on every page and auto-mark all matches.
    await page.getByTestId('redact-search').fill('Test Document');
    await page.getByTestId('redact-find').click();
    await expect(page.getByText(/area(s)? marked for redaction/)).toBeVisible();
    await expect(page.getByTestId('search-note')).toHaveText('Marked 3 matches on 3 pages.');

    await page.getByTestId('confirm-redaction').check();
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());

    // Every "Test Document" is gone across all pages; body text survives.
    const text = await extractPdfText(bytes);
    expect(text).not.toContain('Test Document');
    expect(text).toContain('sample body text');

    // The result pane checked the redacted file for the phrase too.
    await expect(page.getByTestId('verify-phrase')).toHaveText('“Test Document” no longer appears in the file.');
    await expect(page.getByTestId('verify-under-marks')).toHaveText('No text found under any of your 3 marks in the redacted file.');

    // The SHA-256 panel shows distinct before/after digests.
    await expect(page.getByTestId('sha-panel')).toBeVisible();
    const before = await page.getByTestId('sha-before').innerText();
    const after = await page.getByTestId('sha-after').innerText();
    expect(before).toHaveLength(64);
    expect(after).toHaveLength(64);
    expect(before).not.toBe(after);
  });

  test('a mark can be removed before applying', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);

    await drawMark(page, MARK);
    await openOptions(page);
    await expect(page.getByText(/1 area marked/)).toBeVisible();
    await page.getByRole('button', { name: 'Remove mark 1 on page 1' }).click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);
    // With no marks, the action stays where it is, disabled, and says why.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Mark at least one area to redact first');
  });
});
