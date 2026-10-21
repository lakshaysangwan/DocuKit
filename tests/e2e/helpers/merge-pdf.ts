import { type Page, expect } from '@playwright/test';
import { uploadFiles, expectDownload, assertPdf, extractPdfText, countPdfPagesStrict } from './harness';

/**
 * Helpers for Merge PDF's page-level workspace. The point of them is one
 * comparison: the order the grid shows against the order of the pages in the
 * DOWNLOADED file.
 */

type Upload = string | { name: string; mimeType: string; buffer: Buffer };

/** Open Merge PDF with some PDFs and wait until `pages` page cards are drawn. */
export async function openMerge(page: Page, files: Upload[], pages: number) {
  await page.goto('/merge-pdf');
  await uploadFiles(page, files as string[]);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('file-row')).toHaveCount(files.length);
  await expect(page.getByTestId('merge-page')).toHaveCount(pages, { timeout: 30_000 });
  // Every file read: the range fields are open.
  for (const input of await page.getByTestId('page-range-input').all()) await expect(input).toBeEnabled();
  // And every thumbnail drawn, so nothing is still being laid out under a drag.
  await expect(page.getByTestId('merge-page-image')).toHaveCount(pages, { timeout: 30_000 });
}

/** What the grid says each page is, in order: "A · page 2". */
export async function gridOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="page-grid"] [data-testid="merge-page"] [data-testid="page-detail"]')
    .allTextContents()
    .then((all) => all.map((t) => t.trim()));
}

/**
 * Drag the card at `from` onto the card at `to` with the mouse, the way a
 * visitor does it: press on the page, move past dnd-kit's 5px threshold, glide
 * to the target, release. Then wait out the clicks dnd-kit swallows after a drop.
 */
export async function dragPage(page: Page, from: number, to: number) {
  const cards = page.getByTestId('merge-page');
  const a = (await cards.nth(from).getByTestId('page-thumb').boundingBox())!;
  const b = (await cards.nth(to).getByTestId('page-thumb').boundingBox())!;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 12, ay + 4, { steps: 4 });
  // The drag has really started (WebKit can be a beat behind) before gliding to the target.
  await expect(cards.nth(from)).toHaveAttribute('data-dragging', 'true');
  await page.mouse.move(bx, by, { steps: 20 });
  await page.waitForTimeout(100);
  await page.mouse.move(bx + 1, by + 1);
  await page.waitForTimeout(50);
  await page.mouse.up();
  await expect(page.locator('[data-testid="merge-page"][data-dragging="true"]')).toHaveCount(0);
  await page.waitForTimeout(150);
}

/** Press Merge, wait for the download to take its place, and fetch the file. */
export async function mergeAndDownload(page: Page, timeout = 45_000): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click(), { timeout });
  assertPdf(bytes);
  expect(name).toBe('merged.pdf');
  return bytes;
}

/**
 * Each page of a merged file, named by the text printed on it: "3:1" for the
 * fixtures' "Page 1 of 3", "Alpha:2" for "Alpha — page 2", "" for a blank page.
 * Read from the file with pdf.js, nothing from the app.
 */
export async function filePageOrder(bytes: Buffer): Promise<string[]> {
  const count = await countPdfPagesStrict(bytes);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await extractPdfText(bytes, i);
    const plain = /Page (\d+) of (\d+)/.exec(text);
    const named = /(Alpha|Beta) — page (\d+)/.exec(text);
    out.push(plain ? `${plain[2]}:${plain[1]}` : named ? `${named[1]}:${named[2]}` : text.trim() === '' ? '' : `?${text.trim().slice(0, 30)}`);
  }
  return out;
}
