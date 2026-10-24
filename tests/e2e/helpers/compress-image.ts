import { type Page, expect } from '@playwright/test';
import { expectImageRendered, uploadBuffer, uploadFiles } from './harness';

/**
 * Helpers for Compress Image's workspace. What they check is files: the bytes
 * that download and the pixels they decode to, decoded by the browser itself.
 */

/** Open Compress Image with one or more files and wait until the (first) image is drawn on the stage. */
export async function openCompressImage(page: Page, files: string | string[], url = '/compress-image') {
  await page.goto(url);
  await uploadFiles(page, files);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('compare-before'), 30_000);
}

/** Open it with an in-memory file. */
export async function openCompressImageBuffer(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/compress-image');
  await uploadBuffer(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('compare-before'), 30_000);
}

/** On a phone the options are in a closed panel; open it. Elsewhere it does nothing. */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

export async function chooseFormat(page: Page, format: 'jpeg' | 'webp' | 'avif' | 'png') {
  await openOptions(page);
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute('aria-pressed', 'true');
}

export async function setQuality(page: Page, value: number) {
  await openOptions(page);
  await page.getByLabel('Quality', { exact: true }).fill(String(value));
  await expect(page.getByTestId('quality-value')).toHaveText(String(value));
}

export async function setTarget(page: Page, kb: number) {
  await openOptions(page);
  await page.getByRole('button', { name: 'Target size' }).click();
  await page.getByLabel('Target size (KB)').fill(String(kb));
}

/** Wait for the live/requested preview of the current settings to be on screen. */
export async function settledPreview(page: Page) {
  const status = page.getByTestId('stage-status');
  await expect(status).toHaveAttribute('data-preview', 'ready', { timeout: 60_000 });
  await expect(status).toHaveAttribute('data-source', 'preview');
  await expectImageRendered(page.getByTestId('compare-after'), 30_000);
}

/** Press the action and wait for the download in its place. */
export async function compressImages(page: Page) {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
}

/** The bytes behind an `<img>` on the page (a blob: URL), as the page holds them. */
export async function imageBytes(page: Page, testId: string): Promise<Buffer> {
  const b64 = await page.getByTestId(testId).evaluate(async (el: HTMLImageElement) => {
    const buf = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

export interface Decoded {
  width: number;
  height: number;
  /** RGBA of the pixel at each requested point. */
  at: number[][];
}

/** Decode image bytes in the browser and read pixels at the given points. */
export async function decodeImage(page: Page, bytes: Buffer, points: [number, number][] = []): Promise<Decoded> {
  return page.evaluate(
    async ({ b64, points }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([arr]));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const at = points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
      return { width: bitmap.width, height: bitmap.height, at };
    },
    { b64: bytes.toString('base64'), points },
  );
}

/**
 * A PNG made in the browser: the left half fully transparent, the right half
 * opaque red with a little seeded grain in it. The grain is there so the PNG is
 * reliably larger than the JPEG made from it: a flat half-red PNG is under 1 KB
 * on some browsers' encoders (Linux WebKit among them), smaller than any JPEG,
 * and the tool then — rightly — keeps the original instead of converting it.
 */
export async function transparentPng(page: Page, width = 240, height = 160): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const half = ctx.createImageData(width / 2, height);
      let seed = 12345;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) >>> 0;
        return (seed >>> 16) / 65536;
      };
      for (let i = 0; i < half.data.length; i += 4) {
        half.data[i] = 205 + Math.floor(rand() * 40);
        half.data[i + 1] = 5 + Math.floor(rand() * 30);
        half.data[i + 2] = 5 + Math.floor(rand() * 30);
        half.data[i + 3] = 255;
      }
      ctx.putImageData(half, width / 2, 0);
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    },
    { width, height },
  );
  return Buffer.from(b64, 'base64');
}
