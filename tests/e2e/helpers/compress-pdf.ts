import { type Locator, type Page, expect } from '@playwright/test';
import { expectImageRendered, uploadFiles } from './harness';

/**
 * Helpers for Compress PDF's workspace. What they measure is pixels: the two
 * images of the compare view, drawn to a canvas in the page and differenced.
 */

/** Open Compress PDF with a file and wait until the page is drawn on the stage. */
export async function openCompress(page: Page, file: string, url = '/compress-pdf') {
  await page.goto(url);
  await uploadFiles(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('compare-before'), 30_000);
}

/** On a phone the options are in a closed panel; open it. Elsewhere it does nothing. */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

/** Pick a level by its name: "High", "Target size". */
export async function chooseLevel(page: Page, label: string) {
  await openOptions(page);
  const button = page.getByTestId('compress-levels').getByRole('button', { name: new RegExp(`^${label}`) });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Press Compress PDF and wait for the compare view of the real output. */
export async function compressAndCompare(page: Page) {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
  await expectOutputCompare(page);
}

/** The compare view shows the real output: two images, both painted. */
export async function expectOutputCompare(page: Page) {
  const preview = page.getByTestId('compress-preview');
  await expect(preview).toHaveAttribute('data-source', 'output', { timeout: 30_000 });
  await expect(preview.locator('img')).toHaveCount(2);
  await expectImageRendered(preview.getByTestId('compare-before'));
  await expectImageRendered(preview.getByTestId('compare-after'));
}

/**
 * Wait for the live preview of the current settings: both images painted, no
 * update pending. Where the preview waits to be asked (a phone, an engine
 * that cannot draw in a worker) it presses "Preview quality" first.
 */
export async function settledPreview(page: Page) {
  const button = page.getByTestId('preview-quality');
  if ((await button.isVisible()) && (await button.isEnabled())) await button.click();
  const preview = page.getByTestId('compress-preview');
  await expect(preview).toHaveAttribute('data-source', 'preview', { timeout: 60_000 });
  await expect(preview).toHaveAttribute('data-busy', 'false', { timeout: 60_000 });
  await expect(preview.locator('img')).toHaveCount(2);
  await expectImageRendered(preview.getByTestId('compare-before'));
  await expectImageRendered(preview.getByTestId('compare-after'));
}

/** "Images on this page: 25.7 KB → 3.3 KB" → bytes before and after (1 KB = 1024 bytes). */
export function parsePageBytes(text: string): { before: number; after: number } {
  const m = /Images on this page: ([\d.]+) (B|KB|MB) → ([\d.]+) (B|KB|MB)/.exec(text);
  if (!m) throw new Error(`no page sizes in "${text}"`);
  const unit = { B: 1, KB: 1024, MB: 1024 * 1024 } as const;
  return { before: Number(m[1]) * unit[m[2] as 'B'], after: Number(m[3]) * unit[m[4] as 'B'] };
}

/** Pixels of an `<img>` at its natural size. */
async function pixelsOf(img: Locator) {
  await expectImageRendered(img);
  return img.evaluate(async (el: HTMLImageElement) => {
    await el.decode().catch(() => {});
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(el, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
      src: el.src,
    };
  });
}

export type Pixels = Awaited<ReturnType<typeof pixelsOf>>;

/** Read the before and after images of the compare view. */
export async function comparePixels(page: Page): Promise<{ before: Pixels; after: Pixels }> {
  const preview = page.getByTestId('compress-preview');
  return {
    before: await pixelsOf(preview.getByTestId('compare-before')),
    after: await pixelsOf(preview.getByTestId('compare-after')),
  };
}

/** Read the after image alone. */
export async function afterPixels(page: Page): Promise<Pixels> {
  return pixelsOf(page.getByTestId('compress-preview').getByTestId('compare-after'));
}

/** Mean absolute difference per RGB channel, 0–255. The two must be the same size. */
export function meanDiff(a: Pixels, b: Pixels): number {
  expect(a.width, 'same width').toBe(b.width);
  expect(a.height, 'same height').toBe(b.height);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 3;
  }
  return sum / n;
}

/** Mean brightness, 0–255. */
export function meanLuma(p: Pixels): number {
  let sum = 0;
  for (let i = 0; i < p.data.length; i += 4) sum += 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2];
  return sum / (p.data.length / 4);
}
