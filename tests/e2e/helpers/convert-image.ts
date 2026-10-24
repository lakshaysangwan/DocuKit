import { type Page, expect } from '@playwright/test';
import { expectDownload, expectImageRendered, uploadBuffer, uploadFiles } from './harness';
import { openOptions } from './compress-image';

export { chooseFormat, decodeImage, imageBytes, openOptions, setQuality, transparentPng } from './compress-image';

/**
 * Helpers for Convert Image's workspace. Like Compress Image's, what they check
 * is files: the bytes that download and the pixels they decode to.
 */

/** Open Convert Image (or one of its task pages) with files and wait until the (first) image is drawn. */
export async function openConvert(page: Page, files: string | string[], url = '/convert-image') {
  await page.goto(url);
  await uploadFiles(page, files);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('compare-before'), 45_000);
}

/** Open it with an in-memory file. */
export async function openConvertBuffer(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/convert-image');
  await uploadBuffer(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('compare-before'), 45_000);
}

/** Wait for the preview of the current settings to be on screen. */
export async function settledPreview(page: Page) {
  const status = page.getByTestId('stage-status');
  await expect(status).toHaveAttribute('data-preview', 'ready', { timeout: 60_000 });
  await expect(status).toHaveAttribute('data-source', 'preview');
  await expectImageRendered(page.getByTestId('compare-after'), 30_000);
}

/** Press the action, wait for the download in its place, and download the single file. */
export async function convertAndDownload(page: Page) {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
  return expectDownload(page, () => page.getByTestId('download-button').click());
}

/** Choose a format with the options pane opened first on a phone. */
export async function pickFormat(page: Page, format: 'jpeg' | 'png' | 'webp' | 'avif') {
  await openOptions(page);
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute('aria-pressed', 'true');
}

/**
 * A 24-bit BMP built byte by byte (no browser can encode one): the left half
 * red, the right half blue.
 */
export function halvesBmp(width = 64, height = 40): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = 54 + y * row + x * 3;
      // BGR
      if (x < width / 2) b.set([20, 20, 220], o);
      else b.set([220, 40, 20], o);
    }
  }
  return b;
}

export const isRed = ([r, g, b, a]: number[]) => a > 200 && r > 170 && g < 80 && b < 80;
export const isBlue = ([r, g, b, a]: number[]) => a > 200 && b > 170 && r < 80 && g < 100;
export const isWhite = ([r, g, b, a]: number[]) => a > 200 && r > 235 && g > 235 && b > 235;
export const isClear = ([, , , a]: number[]) => a < 10;
