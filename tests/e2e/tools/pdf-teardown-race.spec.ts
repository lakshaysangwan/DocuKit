import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, assertPdf, countPdfPagesStrict, expectDownload } from '../helpers/harness';

declare global {
  interface Window {
    __pdfTerminateRequests: number;
  }
}

/** How long pdf.js's teardown request to its worker is held back. */
const TEARDOWN_DELAY_MS = 3000;

/**
 * Crop PDF's preview opens the file, draws page 1 and destroys its pdf.js
 * document without waiting. Flatten mode opens the file again the moment Crop is
 * clicked. If that second open lands while the worker is still acknowledging the
 * teardown, pdf.js used to throw "PDFWorker.create - the worker is being
 * destroyed. Please remember to await PDFDocumentLoadingTask.destroy()-calls",
 * and the crop failed with that message.
 *
 * The window is normally a few milliseconds, which made this a 2-in-30 flake.
 * Here pdf.js's own `Terminate` message to its worker is held back for three
 * seconds, so the click always lands inside the window: before the fix in
 * src/lib/pdfjs.ts (one shared PDFWorker handed to every getDocument, so no
 * document owns the worker it is tearing down) this test fails every time.
 */
test('Crop PDF Flatten works when clicked while the preview document is still being torn down', async ({ page }) => {
  test.setTimeout(120_000);

  await page.addInitScript((delay: number) => {
    window.__pdfTerminateRequests = 0;
    const post = Worker.prototype.postMessage as (this: Worker, ...args: unknown[]) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      if ((args[0] as { action?: string } | null)?.action === 'Terminate') {
        window.__pdfTerminateRequests++;
        setTimeout(() => post.apply(this, args), delay);
        return;
      }
      post.apply(this, args);
    } as typeof Worker.prototype.postMessage;
  }, TEARDOWN_DELAY_MS);

  await page.goto('/crop-pdf');
  await addSingleFileAndWait(page, FIXTURE.pdf3page);

  // The preview has asked for its document to be destroyed; the worker has not
  // been told yet.
  await expect.poll(() => page.evaluate(() => window.__pdfTerminateRequests), { timeout: 20_000 }).toBeGreaterThan(0);

  await page.getByTestId('crop-mode-flatten').click();
  await page.getByLabel('top margin').fill('40');
  await page.getByTestId('tool-action').click();

  // Either it finishes or it reports the race; fail on the message itself
  // rather than on a download that never comes.
  const raced = page.getByText(/worker is being destroyed/i);
  await expect(page.getByTestId('download-button').or(raced).first()).toBeVisible({ timeout: 90_000 });
  await expect(raced).toHaveCount(0);

  const { bytes } = await expectDownload(
    page,
    () => page.getByTestId('download-button').click(),
    { timeout: 30_000 },
  );
  assertPdf(bytes);
  expect(await countPdfPagesStrict(bytes)).toBe(3);
});
