import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, uploadFiles } from '../helpers/harness';

/**
 * Privacy guard: DocuKit promises everything runs locally — nothing should be
 * fetched from a third-party origin. This catches regressions like the PDF→Image
 * bug, where the pdf.js worker was loaded from unpkg.com (breaking offline use
 * and the "nothing leaves your device" guarantee).
 *
 * We record every request whose origin isn't the app origin (allowing data:,
 * blob: and the dev server's own websocket) while exercising the most
 * worker-dependent tools, and assert the list is empty.
 */
function attachOriginWatcher(page: import('@playwright/test').Page, appOrigin: string) {
  const external: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (url.startsWith(appOrigin)) return;
    // Vite HMR websocket in dev connects to ws://localhost — same host, allow.
    if (url.startsWith('ws://localhost') || url.startsWith('http://localhost')) return;
    external.push(url);
  });
  return external;
}

test('PDF→Image converts using only local resources', async ({ page, baseURL }) => {
  const external = attachOriginWatcher(page, baseURL!);
  await page.goto('/pdf-to-image');
  await addSingleFileAndWait(page, FIXTURE.pdf3page);
  await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  expect(external, `unexpected cross-origin requests:\n${external.join('\n')}`).toEqual([]);
});

test('Edit PDF renders pages using only local resources', async ({ page, baseURL }) => {
  const external = attachOriginWatcher(page, baseURL!);
  await page.goto('/edit-pdf');
  // edit-pdf swaps the dropzone out for the editor once the PDF loads.
  await uploadFiles(page, FIXTURE.pdf3page);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30_000 });
  expect(external, `unexpected cross-origin requests:\n${external.join('\n')}`).toEqual([]);
});
