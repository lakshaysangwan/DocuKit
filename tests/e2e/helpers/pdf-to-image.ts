import { type Page, expect } from '@playwright/test';
import { uploadFiles } from './harness';

/**
 * Helpers for PDF to Image's workspace. What they serve is one comparison:
 * what the page grid, the output list and the enlarged preview promise,
 * against the image files actually downloaded.
 */

/** Open PDF to Image with a PDF and wait until all `pages` are drawn and the action can be judged. */
export async function openPdfToImage(page: Page, file: string, pages: number, url = '/pdf-to-image') {
  await page.goto(url);
  await uploadFiles(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('p2i-page')).toHaveCount(pages, { timeout: 30_000 });
  await expect(page.getByTestId('p2i-page-image')).toHaveCount(pages, { timeout: 30_000 });
}

/** On a phone the options are in a closed panel; open it. Elsewhere it does nothing. */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

/** The output list: one row per image that will be produced. */
export async function outputList(page: Page): Promise<{ name: string; width: number; height: number }[]> {
  return page.getByTestId('p2i-output').evaluateAll((rows) =>
    rows.map((r) => ({
      name: r.getAttribute('data-name') ?? '',
      width: Number(r.getAttribute('data-width')),
      height: Number(r.getAttribute('data-height')),
    })),
  );
}

/** Which page toggles are pressed, in page order. */
export async function pressedPages(page: Page): Promise<number[]> {
  const states = await page
    .locator('[data-testid^="page-select-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-pressed') === 'true'));
  return states.flatMap((on, i) => (on ? [i + 1] : []));
}

/** The tag on each page card, in page order. */
export async function gridMarks(page: Page): Promise<string[]> {
  return page.getByTestId('p2i-page').evaluateAll((cards) => cards.map((c) => c.getAttribute('data-mark') ?? ''));
}

/**
 * Open page `pageIndex` large and wait for the preview drawn with exactly
 * these settings. Returns the preview image's natural size and its bytes.
 */
export async function openPreview(
  page: Page,
  pageIndex: number,
  want: { format: string; dpi: number; quality?: number },
): Promise<{ width: number; height: number; bytes: Buffer; type: string }> {
  await page.getByTestId('p2i-page').nth(pageIndex).getByTestId('page-open').click();
  const dialog = page.getByTestId('page-preview-dialog');
  await expect(dialog).toBeVisible();
  const img = dialog.getByTestId('p2i-preview-image');
  await expect(img).toHaveAttribute('data-page', String(pageIndex), { timeout: 60_000 });
  await expect(img).toHaveAttribute('data-format', want.format, { timeout: 60_000 });
  await expect(img).toHaveAttribute('data-dpi', String(want.dpi), { timeout: 60_000 });
  if (want.quality !== undefined) await expect(img).toHaveAttribute('data-quality', String(want.quality), { timeout: 60_000 });
  await expect(dialog.getByTestId('p2i-preview-status')).toHaveText('Preview up to date.', { timeout: 60_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  const info = await img.evaluate(async (el: HTMLImageElement) => {
    const blob = await (await fetch(el.src)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { width: el.naturalWidth, height: el.naturalHeight, b64: btoa(bin), type: blob.type };
  });
  return { width: info.width, height: info.height, bytes: Buffer.from(info.b64, 'base64'), type: info.type };
}

/**
 * Mean absolute difference per channel (0–255) between two encoded images of
 * the same size, decoded by the browser.
 */
export async function meanDifference(page: Page, a: Buffer, b: Buffer, type: string): Promise<number> {
  return page.evaluate(
    async ({ a64, b64, mime }) => {
      const decode = async (s: string) => {
        const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [x, y] = await Promise.all([decode(a64), decode(b64)]);
      if (x.width !== y.width || x.height !== y.height) return Number.POSITIVE_INFINITY;
      let sum = 0;
      for (let i = 0; i < x.data.length; i++) sum += Math.abs(x.data[i] - y.data[i]);
      return sum / x.data.length;
    },
    { a64: a.toString('base64'), b64: b.toString('base64'), mime: type },
  );
}
