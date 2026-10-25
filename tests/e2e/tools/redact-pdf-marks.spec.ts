import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, rgb } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import { countPdfPagesStrict, expectDownload } from '../helpers/harness';
import { readFile } from 'node:fs/promises';
import {
  addedBlackBounds,
  drawMark,
  expectSameRect,
  goToPage,
  inside,
  markViewRect,
  openOptions,
  openRedact,
  pageImages,
  pageText,
  redactAndDownload,
  regionDiff,
  regionSpread,
  renderPage,
  strokedPaths,
  textRunsAt,
  type PointerKind,
  type ViewRect,
} from '../helpers/redact-pdf';

/**
 * Redact PDF: what is marked on screen is what is removed from the file.
 *
 * Marks are drawn with a mouse, a finger and a pen (pointer events with that
 * `pointerType`), changed with the overlay and the buttons, and every check
 * reads the downloaded file: its text with pdf.js, its pixels, image data and
 * drawing operations with MuPDF — never the app's own geometry code.
 */

/** doc-3page.pdf, page 1: three lines, one above the other (fractions of the page). */
const TITLE: ViewRect = { x: 0.06, y: 0.07, width: 0.6, height: 0.06 }; // "Test Document"
const PAGE_LINE: ViewRect = { x: 0.06, y: 0.138, width: 0.4, height: 0.04 }; // "Page 1 of 3"
const BODY: ViewRect = { x: 0.06, y: 0.2, width: 0.62, height: 0.04 }; // "This is sample body text…"

/** Half a percent of the page: how close the black area must be to the mark shown. */
const TOLERANCE = 0.005;

test.describe('Redact PDF — marks by mouse, touch and pen', () => {
  const cases: { kind: PointerKind; rect: ViewRect; gone: string; kept: string[] }[] = [
    { kind: 'mouse', rect: TITLE, gone: 'Test Document', kept: ['Page 1 of 3', 'sample body text'] },
    { kind: 'touch', rect: PAGE_LINE, gone: 'Page 1 of 3', kept: ['Test Document', 'sample body text'] },
    { kind: 'pen', rect: BODY, gone: 'sample body text', kept: ['Test Document', 'Page 1 of 3'] },
  ];
  for (const c of cases) {
    test(`a mark drawn by ${c.kind} removes exactly the text under it`, async ({ page }) => {
      await openRedact(page, FIXTURE.pdf3page);
      await drawMark(page, c.rect, c.kind);
      await expect(page.getByTestId('rail-badge-1')).toHaveText('1');
      const shown = await markViewRect(page);
      expectSameRect(shown, c.rect, 0.01, 'mark on screen');

      const bytes = await redactAndDownload(page);
      expect(await countPdfPagesStrict(bytes)).toBe(3);
      const text = await pageText(bytes, 0);
      expect(text, 'text under the mark is gone').not.toContain(c.gone);
      for (const keep of c.kept) expect(text, `text beside the mark stays: ${keep}`).toContain(keep);
      // Nothing is left under the mark at all.
      for (const run of await textRunsAt(bytes, 0)) expect(inside(shown, run), `"${run.str}" under the mark`).toBe(false);
      // The black box in the file is where the mark was shown.
      const source = await readFile(FIXTURE.pdf3page);
      expectSameRect(addedBlackBounds(await renderPage(source, 0), await renderPage(bytes, 0)), shown, TOLERANCE, 'black area');
      // The other pages are untouched.
      expect(await pageText(bytes, 1)).toContain('Test Document');
    });
  }

  test('the page under a mark can be drawn on with the overlay, and the page itself does not scroll-steal', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    // Drawing on: the layer takes touch gestures; the viewer around the page still scrolls.
    await expect(page.getByTestId('draw-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.getByTestId('overlay-layer').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    expect(await page.getByTestId('page-viewer').evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none');
    // Drawing off: a finger scrolls the page, and a drag draws nothing.
    await page.getByTestId('draw-toggle').click();
    await expect(page.getByTestId('draw-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.getByTestId('overlay-layer').evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none');
    const box = (await page.getByTestId('page-canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);
  });
});

test.describe('Redact PDF — changing marks changes the file', () => {
  test('move, resize, remove, undo and redo are all reflected in the output', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);

    // A over the title, B over the left of "Page 1 of 3" only.
    await drawMark(page, TITLE);
    const a = page.getByTestId('overlay-item').nth(0);
    await drawMark(page, { ...PAGE_LINE, width: 0.07 });
    const b = page.getByTestId('overlay-item').nth(1);

    // Remove B with the button, undo, redo, undo: B is back.
    await b.click();
    await page.getByTestId('overlay-remove').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(2);
    await page.getByTestId('redo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(2);

    // Resize B by its bottom-right handle so it covers the whole line.
    await b.click();
    const handle = page.getByTestId('overlay-handle-bottom-right');
    const hb = (await handle.boundingBox())!;
    const canvas = (await page.getByTestId('page-canvas').boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + canvas.width * 0.3, hb.y + hb.height / 2, { steps: 6 });
    await page.mouse.up();
    const bRect = await markViewRect(page, b);
    expect(bRect.width).toBeGreaterThan(0.3);

    // Move A down by dragging it, from the title onto the body line.
    const ab = (await a.boundingBox())!;
    await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await page.mouse.down();
    await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2 + canvas.height * 0.13, { steps: 8 });
    await page.mouse.up();
    const aRect = await markViewRect(page, a);
    expect(aRect.y).toBeGreaterThan(0.18);

    const bytes = await redactAndDownload(page);
    const text = await pageText(bytes, 0);
    expect(text, 'A moved away: the title is back').toContain('Test Document');
    expect(text, 'A moved onto the body line').not.toContain('sample body text');
    expect(text, 'B resized over the whole line').not.toContain('of 3');
    for (const run of await textRunsAt(bytes, 0)) {
      expect(inside(aRect, run) || inside(bRect, run), `"${run.str}" under a mark`).toBe(false);
    }
  });

  test('marks on pages 1 and 3 touch only those pages', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    await drawMark(page, TITLE);
    await goToPage(page, 3);
    await drawMark(page, TITLE, 'touch');
    await expect(page.getByTestId('rail-badge-1')).toHaveText('1');
    await expect(page.getByTestId('rail-badge-3')).toHaveText('1');
    await expect(page.getByTestId('rail-badge-2')).toHaveCount(0);
    await openOptions(page);
    await expect(page.getByTestId('mark-count')).toHaveText('2 areas marked for redaction on 2 pages');

    const bytes = await redactAndDownload(page);
    expect(await pageText(bytes, 0)).not.toContain('Test Document');
    expect(await pageText(bytes, 2)).not.toContain('Test Document');
    expect(await pageText(bytes, 1)).toContain('Test Document');
    const source = await readFile(FIXTURE.pdf3page);
    expect(addedBlackBounds(await renderPage(source, 1), await renderPage(bytes, 1)), 'page 2 has no black box').toBeNull();
  });

  test('the result is invalidated by any change, and the next run uses the new marks', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    await drawMark(page, TITLE);
    const first = await redactAndDownload(page);
    expect(await pageText(first, 0)).not.toContain('Test Document');

    // The document pane shows the redacted file itself.
    await expect(page.getByTestId('output-caption')).toHaveText('Redacted — this is your file');
    await expect(page.getByTestId('page-image')).toHaveAttribute('alt', /^Redacted page 1/);
    await expect(page.getByTestId('verify-under-marks')).toHaveText('No text found under any of your 1 mark in the redacted file.');

    await page.getByTestId('edit-again').click();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toBeEnabled();

    // A keyboard move: the mark goes down onto "Page 1 of 3".
    const mark = page.getByTestId('overlay-item').first();
    await mark.focus();
    for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowDown');
    const moved = await markViewRect(page, mark);
    const second = await redactAndDownload(page);
    const text = await pageText(second, 0);
    for (const run of await textRunsAt(second, 0)) expect(inside(moved, run), `"${run.str}" under the moved mark`).toBe(false);
    expect(Buffer.compare(first, second)).not.toBe(0);
    expect(text).toContain('sample body text');

    // Undo after "Make changes" leaves nothing marked: the action says why it cannot run.
    await page.getByTestId('edit-again').click();
    await page.getByTestId('undo').click();
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Mark at least one area to redact first');
  });

  test('Add mark and the millimetre fields place a mark without a pointer', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    await page.getByTestId('add-mark').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
    await openOptions(page);
    const mmPerPt = 25.4 / 72;
    // The title line, typed in millimetres of the 612 × 792 pt page.
    await page.getByTestId('mark-x').fill(String(0.06 * 612 * mmPerPt));
    await page.getByTestId('mark-y').fill(String(0.07 * 792 * mmPerPt));
    await page.getByTestId('mark-width').fill(String(0.6 * 612 * mmPerPt));
    await page.getByTestId('mark-height').fill(String(0.06 * 792 * mmPerPt));
    expectSameRect(await markViewRect(page), TITLE, 0.003, 'typed mark');
    const bytes = await redactAndDownload(page);
    const text = await pageText(bytes, 0);
    expect(text).not.toContain('Test Document');
    expect(text).toContain('Page 1 of 3');
  });
});

/** A one-page PDF with `/UserUnit 2`: each unit is 2pt, so the page is shown twice its stored size. */
async function makeUserUnitPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 400]);
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  page.drawText('Large format secret', { x: 30, y: 340, size: 18, font, color: rgb(0, 0, 0) });
  page.drawText('Large format keep', { x: 30, y: 200, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
  return Buffer.from(await doc.save());
}

test.describe('Redact PDF — the area removed is the area shown, on every page kind', () => {
  const kinds: {
    name: string;
    open: (page: Page) => Promise<Buffer>;
    rect: ViewRect;
    gone: string;
    kept: string;
  }[] = [
    {
      name: 'a /Rotate 90 scan',
      open: async (page) => {
        await openRedact(page, FIXTURE.pdfRotate90);
        return readFile(FIXTURE.pdfRotate90);
      },
      rect: { x: 0.06, y: 0.045, width: 0.33, height: 0.075 },
      gone: 'Rotated scan',
      kept: 'Sign here:',
    },
    {
      name: 'a page with an offset CropBox',
      open: async (page) => {
        await openRedact(page, FIXTURE.pdfCropOffset);
        return readFile(FIXTURE.pdfCropOffset);
      },
      rect: { x: 0.06, y: 0.055, width: 0.38, height: 0.06 },
      gone: 'Cropped page',
      kept: 'Only the middle of the sheet is visible.',
    },
    {
      name: 'a /UserUnit 2 page',
      open: async (page) => {
        const buffer = await makeUserUnitPdf();
        await openRedact(page, { name: 'user-unit.pdf', buffer });
        return buffer;
      },
      rect: { x: 0.06, y: 0.1, width: 0.7, height: 0.08 },
      gone: 'Large format secret',
      kept: 'Large format keep',
    },
  ];
  for (const k of kinds) {
    test(`on ${k.name}`, async ({ page }) => {
      const original = await k.open(page);
      await drawMark(page, k.rect);
      const shown = await markViewRect(page);
      const bytes = await redactAndDownload(page);
      const text = await pageText(bytes, 0);
      expect(text, 'text under the mark is gone').not.toContain(k.gone);
      expect(text, 'text beside the mark stays').toContain(k.kept);
      for (const run of await textRunsAt(bytes, 0)) expect(inside(shown, run), `"${run.str}" under the mark`).toBe(false);
      expectSameRect(addedBlackBounds(await renderPage(original, 0), await renderPage(bytes, 0)), shown, TOLERANCE, 'black area');
    });
  }

  test('a shape the mark covers completely is removed from the drawing, not just covered', async ({ page }) => {
    // The rotated fixture's signature line: a stroke along the displayed bottom, under "Sign here:".
    const source = await readFile(FIXTURE.pdfRotate90);
    const lineBefore = (await strokedPaths(source, 0)).find((b) => b.width > 0.3);
    expect(lineBefore, 'the fixture has the line').toBeTruthy();
    const rect = { x: lineBefore!.x - 0.02, y: lineBefore!.y - 0.012, width: lineBefore!.width + 0.04, height: lineBefore!.height + 0.024 };

    await openRedact(page, FIXTURE.pdfRotate90);
    await drawMark(page, rect);
    const bytes = await redactAndDownload(page);
    const after = await strokedPaths(bytes, 0);
    expect(after.filter((b) => inside(rect, { x: b.x + b.width / 2, y: b.y + b.height / 2 })), 'stroke under the mark').toEqual([]);
    expect(await pageText(bytes, 0)).toContain('Sign here:');
  });

  test('image pixels under a mark are removed from the image itself; the rest of the image stays', async ({ page }) => {
    const source = await readFile(FIXTURE.pdfPhoto);
    const rect = { x: 0.3, y: 0.35, width: 0.3, height: 0.2 };
    // Shrunk a little so edge pixels the image interpolates are not counted.
    const core = { x: rect.x + 0.01, y: rect.y + 0.01, width: rect.width - 0.02, height: rect.height - 0.02 };
    const [before] = await pageImages(source, 0);
    const spreadBefore = regionSpread(before.raster, core);
    expect(spreadBefore.max - spreadBefore.min, 'the photo has detail there to begin with').toBeGreaterThan(30);

    await openRedact(page, FIXTURE.pdfPhoto);
    await drawMark(page, rect);
    const shown = await markViewRect(page);
    const bytes = await redactAndDownload(page);

    const images = await pageImages(bytes, 0);
    expect(images.length, 'the photo is still in the file').toBe(1);
    const [image] = images;
    // The image covers the whole page, so page fractions are image fractions.
    expectSameRect(image.bbox, { x: 0, y: 0, width: 1, height: 1 }, 0.002, 'image placement');
    const inner = { x: shown.x + 0.01, y: shown.y + 0.01, width: shown.width - 0.02, height: shown.height - 0.02 };
    const spread = regionSpread(image.raster, inner);
    expect(spread.max - spread.min, 'the pixels under the mark are all one value').toBeLessThanOrEqual(2);
    // Outside the mark the image is the photo it was: compare a band above and one below the mark.
    const above = { x: 0, y: 0, width: 1, height: shown.y - 0.02 };
    const below = { x: 0, y: shown.y + shown.height + 0.02, width: 1, height: 1 - (shown.y + shown.height + 0.02) };
    expect(regionDiff(before.raster, image.raster, above), 'image above the mark unchanged').toBeLessThan(4);
    expect(regionDiff(before.raster, image.raster, below), 'image below the mark unchanged').toBeLessThan(4);
  });
});

test.describe('Redact PDF — find and mark', () => {
  test('every match is marked on the page it is on, removed, and reported gone', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    await openOptions(page);
    await page.getByTestId('redact-search').fill('page 2 of');
    await page.getByTestId('redact-find').click();
    await expect(page.getByTestId('search-note')).toHaveText('Marked 1 match on 1 page.');
    await expect(page.getByTestId('rail-badge-2')).toHaveText('1');
    await expect(page.getByTestId('rail-badge-1')).toHaveCount(0);

    await page.getByTestId('redact-search').fill('no such words');
    await page.getByTestId('redact-find').click();
    await expect(page.getByTestId('search-note')).toHaveText('No text found containing “no such words”.');

    const bytes = await redactAndDownload(page);
    expect(await pageText(bytes, 1)).not.toContain('Page 2 of 3');
    expect(await pageText(bytes, 1)).toContain('Test Document');
    expect(await pageText(bytes, 0)).toContain('Page 1 of 3');
    await expect(page.getByTestId('verify-phrase')).toHaveText('“page 2 of” no longer appears in the file.');
  });

  test('marks only the phrase, not the line it is on: the rest of the line is still in the file', async ({ page }) => {
    // "This is sample body text for functional testing of Docukit." on each page, searched in other capitals.
    await openRedact(page, FIXTURE.pdf3page);
    await openOptions(page);
    await page.getByTestId('redact-search').fill('SAMPLE BODY');
    await page.getByTestId('redact-find').click();
    await expect(page.getByTestId('search-note')).toHaveText('Marked 3 matches on 3 pages.');

    // The mark on screen covers the two words, not the 12pt line (≈ 0.52 of the page wide).
    const mark = await markViewRect(page, page.getByTestId('overlay-item').first());
    expect(mark.width, 'mark width as a fraction of the page').toBeLessThan(0.17);
    expect(mark.width).toBeGreaterThan(0.1);
    expect(mark.x, 'it starts after "This is "').toBeGreaterThan(60 / 612 + 0.05);

    const bytes = await redactAndDownload(page);
    for (let p = 0; p < 3; p++) {
      const text = await pageText(bytes, p);
      expect(text.toLowerCase(), `page ${p + 1}: the phrase is gone`).not.toContain('sample body');
      expect(text.toLowerCase()).not.toContain('sample');
      expect(text, `page ${p + 1}: the rest of the line is still there`).toMatch(/This is\b/);
      expect(text).toContain('text for functional testing of Docukit.');
      expect(text).toContain('Test Document');
      expect(text).toContain(`Page ${p + 1} of 3`);
    }
    await expect(page.getByTestId('verify-phrase')).toHaveText('“SAMPLE BODY” no longer appears in the file.');
    await expect(page.getByTestId('verify-under-marks')).toHaveText('No text found under any of your 3 marks in the redacted file.');
  });

  test('on a /Rotate 90 scan the mark lands on the word, which goes, and the rest of its line stays', async ({ page }) => {
    // "Rotated scan, page 1", drawn turned so it reads across the displayed page.
    await openRedact(page, FIXTURE.pdfRotate90);
    await openOptions(page);
    await page.getByTestId('redact-search').fill('scan');
    await page.getByTestId('redact-find').click();
    await expect(page.getByTestId('search-note')).toHaveText(/^Marked \d+ match(es)? on \d+ pages?\.$/);

    const runs = await textRunsAt(await readFile(FIXTURE.pdfRotate90), 0);
    const line = runs.find((r) => r.str.startsWith('Rotated scan'))!;
    const mark = await markViewRect(page, page.getByTestId('overlay-item').first());
    // Wider than tall on the displayed page, on the line, and well short of its length.
    expect(mark.width * 792, 'width in points (the page is shown 792 × 612)').toBeGreaterThan(mark.height * 612);
    expect(mark.width).toBeLessThan(0.15);
    expect(Math.abs(mark.y + mark.height / 2 - line.y), 'on the line').toBeLessThan(0.03);

    const bytes = await redactAndDownload(page);
    const text = await pageText(bytes, 0);
    expect(text).not.toContain('scan');
    expect(text).toContain('Rotated');
    expect(text).toContain('page 1');
    expect(text).toContain('Sign here:');
  });

  test('the download is the file the stage shows', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    await drawMark(page, TITLE);
    await openOptions(page);
    await page.getByTestId('confirm-redaction').check();
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
    // Before shows the original, After the redacted file.
    await page.getByTestId('compare-before').click();
    await expect(page.getByTestId('output-caption')).toHaveText('Before — your original');
    await page.getByTestId('compare-after').click();
    await expect(page.getByTestId('page-image')).toHaveAttribute('alt', /^Redacted page/);
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect(await pageText(bytes, 0)).not.toContain('Test Document');
  });
});
