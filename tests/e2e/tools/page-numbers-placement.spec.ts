import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { readPdfContentStreams, extractPdfText } from '../helpers/harness';
import {
  redBoxInViewer,
  expectSameNumber,
  expectUpright,
  fileNumbers,
  goToPage,
  numberAndDownload,
  openPageNumbers,
  screenNumber,
  setSlider,
  waitForOutputPage,
  type ScreenNumber,
} from '../helpers/page-numbers';

/**
 * What you see is what you get: on every page checked, the number drawn over
 * the page has, in the downloaded file, the same text at the same four corners
 * — to 0.5% of the page — for every position and every format, on a plain
 * page, a /Rotate 90 scan (where it must also read upright at the visual
 * bottom), a page whose crop box does not start at 0,0 and a page whose
 * content leaves the coordinate system changed. The screen side is the drawn
 * SVG's own transform; the file side is the content stream mapped through
 * pdf.js. The text is also read back with pdf.js's text extraction.
 */

const RUNS: { position: string; format: string; label: (n: number, total: number) => string }[] = [
  { position: 'bottom-center', format: 'page-n-of-total', label: (n, t) => `Page ${n} of ${t}` },
  { position: 'bottom-left', format: 'n', label: (n) => String(n) },
  { position: 'bottom-right', format: 'page-n', label: (n) => `Page ${n}` },
  { position: 'top-center', format: 'n-of-total', label: (n, t) => `${n}/${t}` },
  { position: 'top-left', format: 'roman', label: (n) => ['i', 'ii', 'iii', 'iv', 'v'][n - 1] },
  { position: 'top-right', format: 'alpha', label: (n) => 'abcde'[n - 1] },
];

const PAGES = [0, 2, 4];

async function screenOn(page: Page, pages: number[]): Promise<Map<number, ScreenNumber | null>> {
  const out = new Map<number, ScreenNumber | null>();
  for (const i of pages) {
    await goToPage(page, i);
    out.set(i, await screenNumber(page));
  }
  return out;
}

test('every position and format: the number in the file matches the screen on pages 1, 3 and 5', async ({ page }) => {
  test.setTimeout(240_000);
  await openPageNumbers(page, FIXTURE.pdf5page);
  for (const run of RUNS) {
    await test.step(`${run.position}, ${run.format}`, async () => {
      await page.getByTestId(`pn-position-${run.position}`).click();
      await page.locator(`input[name="pn-format"][value="${run.format}"]`).check();
      const shown = await screenOn(page, PAGES);
      const bytes = await numberAndDownload(page);
      for (const i of PAGES) {
        const s = shown.get(i)!;
        expect(s?.text, `page ${i + 1} on screen`).toBe(run.label(i + 1, 5));
        expectSameNumber(await fileNumbers(bytes, i), s, `page ${i + 1}`);
        expect(await extractPdfText(bytes, i), `page ${i + 1} text`).toContain(run.label(i + 1, 5));
      }
      await page.getByTestId('edit-again').click();
    });
  }
});

test('skip first N and start number: skipped pages say so and carry nothing; numbering continues from the start number', async ({ page }) => {
  test.setTimeout(120_000);
  await openPageNumbers(page, FIXTURE.pdf5page);
  await page.getByLabel('Skip first N pages').fill('2');
  await expect(page.getByTestId('rail-badge-1')).toHaveText('No number on this page');
  await expect(page.getByTestId('rail-badge-2')).toHaveText('No number on this page');
  await expect(page.getByTestId('rail-badge-3')).toHaveCount(0);
  await expect(page.getByTestId('pn-page-note')).toContainText('No number on this page');
  await expect(page.getByTestId('pn-page-note')).toHaveAttribute('data-numbered', 'false');
  await expect(page.getByTestId('page-numbers-preview')).toHaveCount(0);
  await expect(page.getByTestId('action-hint')).toHaveText('Numbers pages 3–5; the first 2 pages get no number.');

  // "of N" counts the numbered pages.
  await goToPage(page, 2);
  expect((await screenNumber(page))?.text).toBe('Page 1 of 3');
  await expect(page.getByTestId('pn-page-note')).toHaveText('Page 3 will read “Page 1 of 3”.');

  await page.locator('input[name="pn-format"][value="n"]').check();
  await page.getByLabel('Start number').fill('7');
  const shown = await screenOn(page, [2, 3, 4]);
  expect([2, 3, 4].map((i) => shown.get(i)?.text)).toEqual(['7', '8', '9']);
  const bytes = await numberAndDownload(page);
  for (const i of [0, 1]) {
    expect(await fileNumbers(bytes, i), `page ${i + 1} carries no number`).toEqual([]);
    expect((await extractPdfText(bytes, i)).trim(), `page ${i + 1} text`).not.toMatch(/^\d+$|\s\d$/);
  }
  for (const i of [2, 3, 4]) expectSameNumber(await fileNumbers(bytes, i), shown.get(i)!, `page ${i + 1}`);
  await expect(page.getByTestId('page-numbers-result')).toContainText('On pages 3–5; the first 2 pages have no number.');
});

test('skipping every page disables the action and says why', async ({ page }) => {
  await openPageNumbers(page, FIXTURE.pdf3page);
  await page.getByLabel('Skip first N pages').fill('3');
  await expect(page.getByTestId('tool-action')).toBeDisabled();
  await expect(page.getByTestId('action-hint')).toHaveText('Every page is skipped. Lower “Skip first N pages” to number some.');
});

test('font, size, colour and margins reach the file', async ({ page }) => {
  test.setTimeout(120_000);
  await openPageNumbers(page, FIXTURE.pdf3page);
  await page.getByTestId('pn-position-bottom-right').click();
  await page.getByTestId('pn-font').selectOption('Times-Roman');
  await setSlider(page, 'pn-font-size', 18);
  await page.locator('#pn-color').fill('#ff0000');
  await setSlider(page, 'pn-margin-x', 30);
  await setSlider(page, 'pn-margin-y', 25);
  await goToPage(page, 1);
  const shown = (await screenNumber(page))!;
  // The box ends 30 mm from the right edge; its baseline is 25 mm above the bottom (Letter: 612 × 792 pt).
  const mm = 72 / 25.4;
  expect(1 - shown.corners[1][0]).toBeCloseTo((30 * mm) / 612, 3);
  const bytes = await numberAndDownload(page);
  const found = await fileNumbers(bytes, 1, 'Times-Roman');
  expectSameNumber(found, shown, 'page 2');
  expect(found[0].fontSize).toBe(18);
  expect(found[0].colour).toBe('1 0 0');
  const descent = 217 / 1000; // Times-Roman descender, as a fraction of the size
  expect(1 - found[0].corners[0][1] + (18 * descent) / 792).toBeCloseTo((25 * mm) / 792, 3);
  // The fixture's own text is Helvetica, so only the added font can be asserted.
  expect(bytes.toString('latin1')).toContain('/Times-Roman');
});

test('/Rotate 90 scan: upright at the visual bottom centre, in the file and in the rendered output', async ({ page }) => {
  test.setTimeout(120_000);
  await openPageNumbers(page, FIXTURE.pdfRotate90);
  await page.locator('#pn-color').fill('#ff0000');
  await setSlider(page, 'pn-font-size', 24);
  const shown = (await screenNumber(page))!;
  expect(shown.text).toMatch(/^Page 1 of \d+$/);
  expectUpright(shown.corners, 'on screen');
  // Bottom centre of the displayed page.
  expect((shown.corners[0][0] + shown.corners[1][0]) / 2).toBeCloseTo(0.5, 3);
  expect(shown.corners[0][1]).toBeGreaterThan(0.9);
  const bytes = await numberAndDownload(page);
  const found = await fileNumbers(bytes, 0);
  expectSameNumber(found, shown, 'rotated page');
  expectUpright(found[0].corners, 'in the file');
  await waitForOutputPage(page);
  const ink = await redBoxInViewer(page);
  expect(ink, 'red number in the rendered output').not.toBeNull();
  // Wider than tall (upright text, not sideways) and inside the box shown.
  expect(ink!.x2 - ink!.x1).toBeGreaterThan((ink!.y2 - ink!.y1) * 2);
  expect(ink!.x1).toBeGreaterThan(shown.corners[0][0] - 0.01);
  expect(ink!.x2).toBeLessThan(shown.corners[1][0] + 0.01);
  expect(ink!.y1).toBeGreaterThan(shown.corners[3][1] - 0.01);
  expect(ink!.y2).toBeLessThan(shown.corners[0][1] + 0.01);
});

test('offset crop box: the number sits where shown on the visible page', async ({ page }) => {
  test.setTimeout(120_000);
  await openPageNumbers(page, FIXTURE.pdfCropOffset);
  for (const position of ['top-left', 'bottom-right']) {
    await page.getByTestId(`pn-position-${position}`).click();
    const shown = await screenNumber(page);
    const bytes = await numberAndDownload(page);
    expectSameNumber(await fileNumbers(bytes, 0), shown, position);
    await page.getByTestId('edit-again').click();
  }
});

test('a page that leaves its coordinates changed: structure and rendered pixels', async ({ page }) => {
  test.setTimeout(120_000);
  await openPageNumbers(page, FIXTURE.pdfUnbalanced);
  await page.locator('#pn-color').fill('#ff0000');
  await setSlider(page, 'pn-font-size', 24);
  await page.getByTestId('pn-position-top-center').click();
  const shown = (await screenNumber(page))!;
  const bytes = await numberAndDownload(page);
  expectSameNumber(await fileNumbers(bytes, 0), shown, 'unbalanced page');
  // pdf.js forgives a page that leaves states open more than other viewers do,
  // so the pixels alone cannot prove the fix: the page leaves two states open,
  // and the number must start by closing both plus the `q` that isolates the
  // page's content.
  const streams = await readPdfContentStreams(bytes, 0);
  expect(streams[0].trim()).toBe('q');
  expect(streams[streams.length - 1].startsWith('Q\nQ\nQ\nq')).toBe(true);
  await waitForOutputPage(page);
  const ink = await redBoxInViewer(page);
  expect(ink, 'red number in the rendered output').not.toBeNull();
  const cx = (shown.corners[0][0] + shown.corners[1][0]) / 2;
  const cy = (shown.corners[0][1] + shown.corners[3][1]) / 2;
  expect(Math.abs((ink!.x1 + ink!.x2) / 2 - cx)).toBeLessThan(0.01);
  expect(Math.abs((ink!.y1 + ink!.y2) / 2 - cy)).toBeLessThan(0.02);
  expect(ink!.x2 - ink!.x1).toBeGreaterThan((shown.corners[1][0] - shown.corners[0][0]) * 0.8);
});

test('a worker that answers with an error: the action slot says so', async ({ page }) => {
  // Hand the worker bytes that are not a PDF, so pdf-lib fails in the worker
  // and it answers with an error.
  await page.addInitScript(() => {
    const real = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      const m = message as { op?: string; buffer?: ArrayBuffer };
      if (m && m.op === 'add-page-numbers') m.buffer = new TextEncoder().encode('not a pdf').buffer;
      // @ts-expect-error — passing the overloads straight through
      return real.call(this, message, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
  await openPageNumbers(page, FIXTURE.pdf3page);
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('action-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('action-error')).not.toBeEmpty();
  await expect(page.getByRole('status').filter({ hasText: 'could not be added' }).first()).toBeVisible();
  await expect(page.getByTestId('download-button')).toHaveCount(0);
  await expect(page.getByTestId('tool-action')).toBeEnabled();
});

test('a worker that crashes: the action slot says so instead of going back to idle', async ({ page }) => {
  await page.addInitScript(() => {
    const real = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      const m = message as { op?: string };
      if (m && m.op === 'add-page-numbers') {
        setTimeout(() => this.onerror?.(new ErrorEvent('error', { message: 'crashed' })), 50);
        return;
      }
      // @ts-expect-error — passing the overloads straight through
      return real.call(this, message, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
  await openPageNumbers(page, FIXTURE.pdf3page);
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('action-error')).toHaveText(/could not be added/, { timeout: 30_000 });
  await expect(page.getByTestId('download-button')).toHaveCount(0);
});
