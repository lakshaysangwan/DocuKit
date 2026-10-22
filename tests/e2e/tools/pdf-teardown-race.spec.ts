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
 * Crop PDF destroys a pdf.js document without waiting — the output it was
 * showing, once "Make changes" is pressed (until the workspace move, the page 1
 * preview did the same on load). Flatten mode opens the file again the moment
 * Crop is clicked. If that second open lands while the worker is still acknowledging the
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
  await page.getByLabel('top margin').fill('40');

  // A CropBox run opens its output as a document to show it; "Make changes"
  // destroys that document. Then the worker has been asked to tear it down but
  // has not been told yet.
  const before = await page.evaluate(() => window.__pdfTerminateRequests);
  await page.getByTestId('tool-action').click();
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('edit-again').click();
  await expect
    .poll(() => page.evaluate(() => window.__pdfTerminateRequests), { timeout: 20_000 })
    .toBeGreaterThan(before);

  await page.getByTestId('crop-mode-flatten').click();
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
