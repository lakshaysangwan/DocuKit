import { type Page, expect } from '@playwright/test';
import { uploadFiles, expectDownload, assertPdf, extractPdfText, countPdfPagesStrict } from './harness';

/**
 * Helpers for Rearrange / Rotate PDF Pages. The point of them is one
 * comparison: what the grid shows against the pages of the DOWNLOADED file —
 * their order (by the text printed on each), their /Rotate and their count.
 */

/** Open the tool (or a landing page built on it) with a PDF and wait until all `pages` are drawn. */
export async function openOrganize(page: Page, file: string, pages: number, url = '/rearrange-pdf-pages') {
  await page.goto(url);
  await uploadFiles(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('organize-page')).toHaveCount(pages, { timeout: 30_000 });
  await expect(page.getByTestId('organize-page-image')).toHaveCount(pages, { timeout: 30_000 });
}

/** The card at position `i` (0-based) in the grid. */
export const card = (page: Page, i: number) => page.getByTestId('organize-page').nth(i);

/** What each card says it is, in order: "Original page 3 · turned right", "Blank page". */
export async function gridDetails(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="organize-page"] [data-testid="page-detail"]')
    .allTextContents()
    .then((all) => all.map((t) => t.trim()));
}

/** On a phone the options are in a closed panel; open it. Elsewhere it does nothing. */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

/**
 * Drag the card at `from` onto the card at `to` with the mouse: press on the
 * page, move past dnd-kit's 5px threshold, glide to the target, release. Then
 * wait out the clicks dnd-kit swallows after a drop.
 */
export async function dragPage(page: Page, from: number, to: number) {
  const cards = page.getByTestId('organize-page');
  const a = (await cards.nth(from).getByTestId('page-thumb').boundingBox())!;
  const b = (await cards.nth(to).getByTestId('page-thumb').boundingBox())!;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 12, ay + 4, { steps: 4 });
  await expect(cards.nth(from)).toHaveAttribute('data-dragging', 'true');
  await page.mouse.move(bx, by, { steps: 20 });
  await page.waitForTimeout(100);
  await page.mouse.move(bx + 1, by + 1);
  await page.waitForTimeout(50);
  await page.mouse.up();
  await expect(page.locator('[data-testid="organize-page"][data-dragging="true"]')).toHaveCount(0);
  await page.waitForTimeout(150);
}

/** Press Save, wait for the download to take its place, and fetch the file. */
export async function saveAndDownload(page: Page, timeout = 45_000): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click(), { timeout });
  assertPdf(bytes);
  expect(name).toMatch(/-organized\.pdf$/);
  return bytes;
}

/**
 * Each page of the file, named by the text printed on it: "3" for the
 * fixtures' "Page 3 of 5", "R2" for "Rotated scan, page 2", "" for a blank page.
 * Read from the file with pdf.js, nothing from the app.
 */
export async function filePageOrder(bytes: Buffer): Promise<string[]> {
  const count = await countPdfPagesStrict(bytes);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await extractPdfText(bytes, i);
    const plain = /Page (\d+) of \d+/.exec(text);
    const rotated = /Rotated scan, page (\d+)/.exec(text);
    out.push(plain ? plain[1] : rotated ? `R${rotated[1]}` : text.trim() === '' ? '' : `?${text.trim().slice(0, 30)}`);
  }
  return out;
}

/** The /Rotate of every page of the file, read with pdf-lib. */
export async function fileRotations(bytes: Buffer): Promise<number[]> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => p.getRotation().angle);
}

/** The displayed width ÷ height of every page of the file, rounded to 2 places. */
export async function fileShapes(bytes: Buffer): Promise<number[]> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    const r = ((p.getRotation().angle % 360) + 360) % 360;
    const ratio = r === 90 || r === 270 ? height / width : width / height;
    return Math.round(ratio * 100) / 100;
  });
}
