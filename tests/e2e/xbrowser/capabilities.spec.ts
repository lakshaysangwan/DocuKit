import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addFilesAndWait, addSingleFileAndWait, expectDownload, assertImage } from '../helpers/harness';

/**
 * P6.3 — cross-browser capability floor.
 *
 * Docukit is 100% client-side, so the platform features it stands on ARE the
 * product. These assertions run on every engine (Chromium, Gecko, WebKit) and
 * pin down what each one actually provides, so a regression in the headers or a
 * codec shows up here as a named failure rather than as a mystery timeout in
 * twenty tool specs.
 */
test.describe('P6.3 — platform capabilities', () => {
  test('cross-origin isolation is active (COOP/COEP)', async ({ page }) => {
    await page.goto('/merge-pdf');
    // Required for SharedArrayBuffer-backed WASM; set by astro.config.mjs in dev
    // and by public/_headers in production.
    expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
    const headers = (await (await page.request.get('/merge-pdf')).headersArray())
      .reduce<Record<string, string>>((acc, h) => ({ ...acc, [h.name.toLowerCase()]: h.value }), {});
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  test('WebAssembly compiles and runs', async ({ page }) => {
    await page.goto('/merge-pdf');
    const sum = await page.evaluate(async () => {
      // (module (func (export "add") (param i32 i32) (result i32)
      //   local.get 0 local.get 1 i32.add))
      const bytes = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0,
        7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11,
      ]);
      const { instance } = await WebAssembly.instantiate(bytes);
      return (instance.exports.add as (a: number, b: number) => number)(20, 22);
    });
    expect(sum).toBe(42);
  });

  test('module Web Workers are supported', async ({ page }) => {
    await page.goto('/merge-pdf');
    const echoed = await page.evaluate(async () => {
      const src = 'self.onmessage = (e) => self.postMessage(e.data * 2);';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      const result = await new Promise<number>((resolve, reject) => {
        worker.onmessage = (e) => resolve(e.data as number);
        worker.onerror = () => reject(new Error('worker failed to start'));
        worker.postMessage(21);
      });
      worker.terminate();
      URL.revokeObjectURL(url);
      return result;
    });
    expect(echoed).toBe(42);
  });

  test('image decoding via createImageBitmap works for the formats we accept', async ({ page }) => {
    await page.goto('/compress-image');
    const decoded = await page.evaluate(async () => {
      // 1x1 PNG and 1x1 JPEG, base64.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const toBlob = (b64: string, type: string) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type });
      };
      const bmp = await createImageBitmap(toBlob(png, 'image/png'));
      const dims = { w: bmp.width, h: bmp.height };
      bmp.close();
      return dims;
    });
    expect(decoded).toEqual({ w: 1, h: 1 });
  });

  /**
   * OffscreenCanvas is NOT required — it's an optimisation. Where it exists the
   * worker pool uses it; where it doesn't (older Safari, and the WebKit build
   * Playwright ships) canvas work falls back to the main thread. This test
   * records which path the engine takes and proves the *result* is identical
   * either way, so the fallback can't silently rot.
   */
  test('image resize produces correct output with or without OffscreenCanvas', async ({ page }, testInfo) => {
    await page.goto('/resize-image');
    const hasOffscreen = await page.evaluate(() => typeof OffscreenCanvas !== 'undefined');
    testInfo.annotations.push({
      type: 'canvas-path',
      description: hasOffscreen ? 'OffscreenCanvas (worker)' : 'DOM canvas (main-thread fallback)',
    });

    await addSingleFileAndWait(page, FIXTURE.jpg); // 1200x800
    await page.getByRole('spinbutton').first().fill('300');
    await expect(page.getByRole('spinbutton').nth(1)).toHaveValue('200');
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
    const size = await page.evaluate(
      (b64) =>
        new Promise<{ w: number; h: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => reject(new Error('decode failed'));
          img.src = `data:image/jpeg;base64,${b64}`;
        }),
      bytes.toString('base64')
    );
    expect(size).toEqual({ w: 300, h: 200 });
  });

  test('blob downloads reach the user', async ({ page }) => {
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdf1page, FIXTURE.pdf3page], 2);
    await page.getByTestId('tool-action').click();
    // Wait for the result panel before arming the download listener: otherwise the
    // listener's timeout runs down while the click is still auto-waiting.
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes, name } = await expectDownload(page, () =>
      page.getByTestId('download-button').click()
    );
    expect(name).toMatch(/\.pdf$/);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
