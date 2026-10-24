import { type Page, expect } from '@playwright/test';
import { expectDownload, expectImageRendered, uploadBuffer, uploadFiles } from './harness';
import { openOptions } from './compress-image';

export { decodeImage, openOptions } from './compress-image';

/**
 * Helpers for Resize Image's workspace. The stage draws the output frame from
 * the same layout the writer uses; these read that layout off the frame and
 * the downloaded file's pixels, so a test can say "the file is what the frame
 * showed".
 */

/** Open Resize Image with one or more files and wait until the (first) image is drawn in its frame. */
export async function openResize(page: Page, files: string | string[]) {
  await page.goto('/resize-image');
  await uploadFiles(page, files);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('resize-frame-image'), 30_000);
}

/** Open it with an in-memory file. */
export async function openResizeBuffer(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/resize-image');
  await uploadBuffer(page, file);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expectImageRendered(page.getByTestId('resize-frame-image'), 30_000);
}

/** Turn Keep proportions on or off. */
export async function setLock(page: Page, on: boolean) {
  await openOptions(page);
  const lock = page.getByTestId('lock-aspect');
  if ((await lock.getAttribute('aria-pressed')) !== String(on)) await lock.click();
  await expect(lock).toHaveAttribute('aria-pressed', String(on));
}

/** Type an exact width and height (Keep proportions off, so both stick). */
export async function setSize(page: Page, width: number, height: number) {
  await setLock(page, false);
  await page.getByLabel('Width (px)').fill(String(width));
  await page.getByLabel('Height (px)').fill(String(height));
  await expect(page.getByTestId('resize-frame')).toHaveAttribute('data-frame', `${width},${height}`);
}

export async function chooseFit(page: Page, mode: 'fit' | 'cover' | 'stretch') {
  await openOptions(page);
  await page.getByTestId(`fit-${mode}`).click();
  await expect(page.getByTestId(`fit-${mode}`)).toHaveAttribute('aria-pressed', 'true');
}

export async function chooseBackground(page: Page, bg: 'white' | 'black' | 'transparent') {
  await openOptions(page);
  await page.getByTestId(`background-${bg}`).click();
  await expect(page.getByTestId(`background-${bg}`)).toHaveAttribute('aria-pressed', 'true');
}

export async function setPercent(page: Page, percent: number) {
  await openOptions(page);
  await page.getByTestId('size-percent').click();
  await page.getByLabel('Scale (%)').fill(String(percent));
}

/** The frame on the stage: its output size and where the image is drawn in it, in output pixels. */
export async function frameLayout(page: Page) {
  const frame = page.getByTestId('resize-frame');
  const [w, h] = (await frame.getAttribute('data-frame'))!.split(',').map(Number);
  const [x, y, dw, dh] = (await frame.getAttribute('data-draw'))!.split(',').map(Number);
  return { width: w, height: h, draw: { x, y, w: dw, h: dh } };
}

/**
 * Where the image is shown on screen relative to its frame, as fractions of the
 * frame — measured from the rendered boxes, not from the attributes.
 */
export async function shownDraw(page: Page) {
  return page.evaluate(() => {
    const f = document.querySelector('[data-testid="resize-frame"]')!.getBoundingClientRect();
    const i = document.querySelector('[data-testid="resize-frame-image"]')!.getBoundingClientRect();
    return { x: (i.left - f.left) / f.width, y: (i.top - f.top) / f.height, w: i.width / f.width, h: i.height / f.height };
  });
}

/** Press the action, wait for the download in its place, and download the single file. */
export async function resizeAndDownload(page: Page) {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
  return expectDownload(page, () => page.getByTestId('download-button').click());
}

/**
 * An image made in the browser: the left half red, the right half blue (or the
 * left half fully transparent with `transparentLeft`). Where the two meet in the
 * output shows exactly where the image was drawn.
 */
export async function halvesImage(
  page: Page,
  { width = 1200, height = 800, type = 'image/png', transparentLeft = false } = {},
): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ width, height, type, transparentLeft }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      if (!transparentLeft) {
        ctx.fillStyle = 'rgb(220, 20, 20)';
        ctx.fillRect(0, 0, width / 2, height);
      }
      ctx.fillStyle = 'rgb(20, 40, 220)';
      ctx.fillRect(width / 2, 0, width / 2, height);
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), type, 0.95));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    },
    { width, height, type, transparentLeft },
  );
  return Buffer.from(b64, 'base64');
}

export const isRed = ([r, g, b, a]: number[]) => a > 200 && r > 170 && g < 80 && b < 80;
export const isBlue = ([r, g, b, a]: number[]) => a > 200 && b > 170 && r < 80 && g < 100;
export const isWhite = ([r, g, b, a]: number[]) => a > 200 && r > 235 && g > 235 && b > 235;
export const isBlack = ([r, g, b, a]: number[]) => a > 200 && r < 20 && g < 20 && b < 20;
export const isClear = ([, , , a]: number[]) => a < 10;
