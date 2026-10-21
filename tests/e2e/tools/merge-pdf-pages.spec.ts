import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  addSingleFileAndWait,
  expectDownload,
  readPdfOutline,
  readPdfInternalLinkTargets,
  uploadBuffer,
  uploadFiles,
} from '../helpers/harness';
import { openMerge, gridOrder, dragPage, mergeAndDownload, filePageOrder } from '../helpers/merge-pdf';

/**
 * Merge PDF, page by page: every page of the merged PDF is shown in output
 * order and can be moved across files, left out, or chosen by range. Every
 * test here reads the DOWNLOADED file to prove the order — the grid is only
 * the claim.
 *
 * A = doc-3page.pdf ("Page n of 3"), B = doc-5page.pdf ("Page n of 5").
 */

const A_B = [FIXTURE.pdf3page, FIXTURE.pdf5page];

test.describe('Merge PDF — pages in the merged PDF', () => {
  test('interleaving pages from two files yields exactly that order', async ({ page }) => {
    await openMerge(page, A_B, 8);
    const ranges = page.getByTestId('page-range-input');
    await ranges.nth(0).fill('1-2');
    await ranges.nth(1).fill('1-2');
    await expect.poll(() => gridOrder(page)).toEqual(['A · page 1', 'A · page 2', 'B · page 1', 'B · page 2']);

    // B·1 onto A·2: A1 B1 A2 B2.
    await dragPage(page, 2, 1);
    await expect.poll(() => gridOrder(page)).toEqual(['A · page 1', 'B · page 1', 'A · page 2', 'B · page 2']);
    await expect(page.getByTestId('merge-page').nth(1).getByTestId('page-label')).toHaveText('Page 2 of 4');
    await expect(page.getByTestId('tool-action')).toHaveText('Merge into 1 PDF (4 pages)');
    await expect(page.getByTestId('step-prompt')).toContainText('Drag pages to change their order');

    const bytes = await mergeAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['3:1', '5:1', '3:2', '5:2']);
  });

  test('× leaves a page out and rewrites that file\'s range', async ({ page }) => {
    await openMerge(page, A_B, 8);
    // Leave out A·page 2.
    await page.getByTestId('merge-page').nth(1).getByTestId('file-remove').click();
    await expect(page.getByTestId('merge-page')).toHaveCount(7);
    await expect(page.getByTestId('page-range-input').nth(0)).toHaveValue('1, 3');
    await expect(page.getByTestId('file-row').nth(0).getByTestId('file-row-facts')).toContainText('2 of 3 pages');

    const bytes = await mergeAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['3:1', '3:3', '5:1', '5:2', '5:3', '5:4', '5:5']);
  });

  test('a typed range replaces the file\'s pages where its first page was', async ({ page }) => {
    await openMerge(page, A_B, 8);
    // Move B·1 to the front, then choose B's pages by range: they stay at the front.
    await dragPage(page, 3, 0);
    await expect.poll(() => gridOrder(page)).toEqual([
      'B · page 1', 'A · page 1', 'A · page 2', 'A · page 3', 'B · page 2', 'B · page 3', 'B · page 4', 'B · page 5',
    ]);
    await page.getByTestId('page-range-input').nth(1).fill('4-5, 2');
    await expect.poll(() => gridOrder(page)).toEqual([
      'B · page 2', 'B · page 4', 'B · page 5', 'A · page 1', 'A · page 2', 'A · page 3',
    ]);
    const bytes = await mergeAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['5:2', '5:4', '5:5', '3:1', '3:2', '3:3']);
  });

  test('a range that cannot be read changes nothing and says why', async ({ page }) => {
    await openMerge(page, A_B, 8);
    const before = await gridOrder(page);
    const input = page.getByTestId('page-range-input').nth(0);
    await input.fill('2-9');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const error = page.getByTestId('file-row').nth(0).getByTestId('page-range-error');
    await expect(error).toContainText('is not a page range in this file');
    await expect(error).toHaveAttribute('aria-live', 'polite');
    // The field points at its message for assistive tech.
    expect(await input.getAttribute('aria-describedby')).toBe(await error.getAttribute('id'));
    expect(await gridOrder(page)).toEqual(before);
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toContainText('Fix the page range for doc-3page.pdf');
    await expect(page.getByTestId('step-prompt')).toContainText('cannot be read');

    // Fixing it applies it.
    await input.fill('3');
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect.poll(() => gridOrder(page)).toEqual(['A · page 3', 'B · page 1', 'B · page 2', 'B · page 3', 'B · page 4', 'B · page 5']);
    await expect(page.getByTestId('tool-action')).toBeEnabled();
  });

  test('moving a file regroups the pages by file, each in its own order', async ({ page }) => {
    await openMerge(page, A_B, 8);
    await page.getByTestId('page-range-input').nth(1).fill('1-2');
    // Interleave: A1 B1 A2 A3 B2, then move A·3 before A·1 within A: A3 A1 B1 A2 B2.
    await dragPage(page, 3, 1);
    await dragPage(page, 3, 0);
    await expect.poll(() => gridOrder(page)).toEqual(['A · page 3', 'A · page 1', 'B · page 1', 'A · page 2', 'B · page 2']);

    // Move file B above A with the keyboard on its handle.
    const handle = page.getByTestId('file-row').nth(1).getByTestId('file-reorder');
    await handle.focus();
    // dnd-kit measures the rows a frame after pick-up, so give each key a moment.
    await expect(handle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('file-row').nth(1)).toHaveAttribute('data-dragging', 'true');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(250);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('file-row').nth(0)).toHaveAttribute('data-filename', 'doc-5page.pdf');
    await expect.poll(() => gridOrder(page)).toEqual(['B · page 1', 'B · page 2', 'A · page 3', 'A · page 1', 'A · page 2']);
    await page.waitForTimeout(100);

    const bytes = await mergeAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['5:1', '5:2', '3:3', '3:1', '3:2']);
  });

  test('"Reset order" puts files in order and pages in page order', async ({ page }) => {
    await openMerge(page, A_B, 8);
    const reset = page.getByTestId('reset-order');
    await expect(reset).toBeDisabled();
    await dragPage(page, 7, 0);
    await dragPage(page, 4, 2);
    await page.getByTestId('merge-page').nth(5).getByTestId('file-remove').click();
    await expect(page.getByTestId('merge-page')).toHaveCount(7);
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect(reset).toBeDisabled();
    // B·2 was left out and stays out; the rest is back in plain order.
    await expect.poll(() => gridOrder(page)).toEqual([
      'A · page 1', 'A · page 2', 'A · page 3', 'B · page 1', 'B · page 3', 'B · page 4', 'B · page 5',
    ]);
    const bytes = await mergeAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['3:1', '3:2', '3:3', '5:1', '5:3', '5:4', '5:5']);
  });

  test('blank pages go in only where the source file changes', async ({ page }) => {
    await openMerge(page, A_B, 8);
    const ranges = page.getByTestId('page-range-input');
    await ranges.nth(0).fill('1-2');
    await ranges.nth(1).fill('1');
    await page.getByTestId('insert-blank-pages').check();
    // A1 A2 B1: one change, so one blank — none between A1 and A2.
    await expect(page.getByTestId('tool-action')).toHaveText('Merge into 1 PDF (4 pages)');
    await dragPage(page, 2, 1);
    // A1 B1 A2: two changes.
    await expect.poll(() => gridOrder(page)).toEqual(['A · page 1', 'B · page 1', 'A · page 2']);
    await expect(page.getByTestId('tool-action')).toHaveText('Merge into 1 PDF (5 pages)');
    const bytes = await mergeAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['3:1', '', '5:1', '', '3:2']);
  });

  test('bookmarks and links still land on the right pages when a file is split into runs', async ({ page }) => {
    test.setTimeout(120_000); // MuPDF's WASM is ~10MB and loads on demand.
    await openMerge(page, [FIXTURE.pdfBookmarks, FIXTURE.pdfBookmarks2], 6);
    await page.getByTestId('preserve-bookmarks').check();
    // A1 A2 A3 B1 B2 B3 → A1 B1 A2 B2 A3 B3.
    await dragPage(page, 3, 1);
    await dragPage(page, 4, 3);
    await expect.poll(() => gridOrder(page)).toEqual([
      'A · page 1', 'B · page 1', 'A · page 2', 'B · page 2', 'A · page 3', 'B · page 3',
    ]);

    const bytes = await mergeAndDownload(page, 90_000);
    expect(await filePageOrder(bytes)).toEqual(['Alpha:1', 'Beta:1', 'Alpha:2', 'Beta:2', 'Alpha:3', 'Beta:3']);

    // One outline per source, written once, each entry at its page's new place.
    const outline = await readPdfOutline(bytes);
    expect(outline.map((o) => o.title)).toEqual([
      'Alpha Chapter 1', 'Alpha Section 1.1', 'Alpha Chapter 2',
      'Beta Chapter 1', 'Beta Section 1.1', 'Beta Chapter 2',
    ]);
    expect(outline.map((o) => o.depth)).toEqual([0, 1, 0, 0, 1, 0]);
    expect(outline.map((o) => o.page)).toEqual([0, 2, 4, 1, 3, 5]);
    // Each file's page-1 link pointed at its page 3, which now lies in a later
    // run: Alpha's at output page 5 (index 4), Beta's at index 5.
    expect(await readPdfInternalLinkTargets(bytes)).toEqual([4, 5]);
  });

  test('blank pages at file changes on the bookmark path too', async ({ page }) => {
    test.setTimeout(120_000);
    await openMerge(page, [FIXTURE.pdfBookmarks, FIXTURE.pdfBookmarks2], 6);
    await page.getByTestId('preserve-bookmarks').check();
    await page.getByTestId('insert-blank-pages').check();
    await page.getByTestId('page-range-input').nth(1).fill('1');
    // A1 B1 A2 A3: blanks after A1 and after B1 only.
    await dragPage(page, 3, 1);
    await expect.poll(() => gridOrder(page)).toEqual(['A · page 1', 'B · page 1', 'A · page 2', 'A · page 3']);
    const bytes = await mergeAndDownload(page, 90_000);
    expect(await filePageOrder(bytes)).toEqual(['Alpha:1', '', 'Beta:1', '', 'Alpha:2', 'Alpha:3']);
    const outline = await readPdfOutline(bytes);
    expect(outline.map((o) => o.page)).toEqual([0, 4, 5, 2]);
  });

  test('an encrypted file unlocks in its row and its pages appear', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByTestId('password').fill('correct horse');
    await page.getByTestId('confirm-password').fill('correct horse');
    await page.getByTestId('tool-action').click();
    const encrypted = await expectDownload(page, () => page.getByTestId('download-button').click(), { timeout: 60_000 });

    await page.goto('/merge-pdf');
    await uploadFiles(page, FIXTURE.pdf5page);
    await uploadBuffer(page, { name: 'locked.pdf', mimeType: 'application/pdf', buffer: encrypted.bytes });
    await expect(page.getByTestId('page-locked')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toContainText('Enter the password for locked.pdf');

    // A wrong one is said so in place.
    await page.getByTestId('merge-password-input').fill('nope');
    await page.getByTestId('merge-unlock').click();
    await expect(page.getByTestId('merge-passwords')).toContainText('That password does not open this file.');
    await expect(page.getByTestId('merge-page')).toHaveCount(6);

    await page.getByTestId('merge-password-input').fill('correct horse');
    await page.getByTestId('merge-unlock').click();
    await expect(page.getByTestId('merge-page')).toHaveCount(8, { timeout: 30_000 });
    await expect(page.getByTestId('page-locked')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toHaveText('Merge into 1 PDF (8 pages)');

    // Its pages are now ordinary pages: put locked.pdf's page 2 first.
    await dragPage(page, 6, 0);
    await expect.poll(() => gridOrder(page).then((o) => o[0])).toBe('B · page 2');
    const bytes = await mergeAndDownload(page, 90_000);
    expect(await filePageOrder(bytes)).toEqual(['3:2', '5:1', '5:2', '5:3', '5:4', '5:5', '3:1', '3:3']);
  });

  test('any change after merging takes the result away', async ({ page }) => {
    await openMerge(page, A_B, 8);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Merge complete')).toBeVisible();
    // The document pane now shows the merged file itself, read back.
    await expect(page.getByTestId('result-page')).toHaveCount(8, { timeout: 30_000 });

    // Make changes: back to the pages, as they were.
    await page.getByTestId('edit-again').click();
    await expect(page.getByTestId('tool-action')).toBeVisible();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    expect(await gridOrder(page)).toHaveLength(8);

    // Done again, then a page is moved: the download goes.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    await page.getByTestId('add-files-input').setInputFiles(FIXTURE.pdf1page);
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toHaveText('Merge into 1 PDF (9 pages)', { timeout: 20_000 });

    // And from the ready state, every kind of edit keeps it from coming back stale.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    await page.getByTestId('edit-again').click();
    await dragPage(page, 8, 0);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect((await filePageOrder(bytes))[0]).toBe('1:1');
  });

  test('a page opens large, and Previous / Next follow the output order', async ({ page }) => {
    await openMerge(page, A_B, 8);
    await dragPage(page, 3, 1);
    await page.getByTestId('merge-page').nth(0).getByTestId('page-open').click();
    const dialog = page.getByTestId('page-preview-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 1 of 8 · doc-3page.pdf');
    await expect(dialog.locator('img')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('page-preview-next').click();
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 2 of 8 · doc-5page.pdf');
    await expect(dialog).toContainText('B · page 1');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
