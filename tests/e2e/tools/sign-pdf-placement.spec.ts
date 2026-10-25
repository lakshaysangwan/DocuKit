import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import { countPdfPagesStrict, extractPdfText, readPdfContentStreams } from '../helpers/harness';
import {
  expectSameRect,
  expectUpright,
  findMarkerInViewer,
  markerCentres,
  openSign,
  readDrawnImages,
  readDrawnText,
  setStampMm,
  signAndDownload,
  stampViewRect,
  addTypedSignature,
  addUploadedSignature,
  chooseSignaturePicture,
  type ViewRect,
} from '../helpers/sign';

/**
 * Sign PDF: what you see is what you get.
 *
 * Every test here places a stamp, notes where it is ON SCREEN, and then reads
 * where it is IN THE DOWNLOADED FILE — from the content stream's own numbers,
 * mapped to the displayed page by pdf.js, not by the app's geometry code. The
 * two must agree to within 0.4% of the page (about 2.5pt on Letter).
 */

const MM_PER_PT = 25.4 / 72;
const TOLERANCE = 0.004;

/** The pages a place-on-page tool gets wrong when it assumes "upright, starts at 0,0". */
const PAGES = [
  { name: 'a plain page', file: FIXTURE.pdf1page, widthPt: 612, heightPt: 792 },
  { name: 'a /Rotate 90 page', file: FIXTURE.pdfRotate90, widthPt: 792, heightPt: 612 },
  { name: 'a page with an offset CropBox', file: FIXTURE.pdfCropOffset, widthPt: 512, heightPt: 642 },
  {
    name: 'a page whose content leaves the coordinate system transformed',
    file: FIXTURE.pdfUnbalanced,
    widthPt: 612,
    heightPt: 792,
  },
];

/** The marker is 3:1; this is the box a marker `widthMm` wide at (xMm, yMm) should occupy. */
function expectedRect(mm: { x: number; y: number; width: number }, page: { widthPt: number; heightPt: number }): ViewRect {
  const widthPt = mm.width / MM_PER_PT;
  return {
    x: mm.x / MM_PER_PT / page.widthPt,
    y: mm.y / MM_PER_PT / page.heightPt,
    width: widthPt / page.widthPt,
    height: widthPt / 3 / page.heightPt,
  };
}

/** Number of image XObjects stored in a PDF. */
async function countStoredImages(bytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') count++;
  }
  return count;
}

async function waitForOutputPage(page: Page) {
  await expect(page.getByTestId('output-caption')).toHaveText('Signed — this is your file');
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('page-image')).toHaveAttribute('alt', /^Signed page/);
}

test.describe('Sign PDF — the stamp lands where it was shown', () => {
  for (const pageCase of PAGES) {
    test(`on ${pageCase.name}`, async ({ page }) => {
      await openSign(page, pageCase.file);
      await addUploadedSignature(page, FIXTURE.signMarker);

      // Ask for an exact rectangle through the number fields…
      const mm = { x: 40, y: 50, width: 60 };
      await setStampMm(page, mm);
      // …and the box on the page is that rectangle.
      const shown = await stampViewRect(page);
      expectSameRect(shown, expectedRect(mm, pageCase), 0.002, 'box on screen');

      const bytes = await signAndDownload(page);

      // 1. The numbers in the file put the image in that rectangle, the right way up.
      const images = await readDrawnImages(bytes, 0);
      expect(images.length, 'one image drawn on the page').toBe(1);
      expectSameRect(images[0].rect, shown, TOLERANCE, 'image in the file');
      expectUpright(images[0], shown, TOLERANCE);

      // 2. And it is PAINTED there: the document pane now shows the output bytes,
      //    so look for the marker's four colours in the rendered page. This is
      //    what catches a transform leaking out of the page's own content.
      await waitForOutputPage(page);
      const found = await findMarkerInViewer(page);
      const want = markerCentres(shown);
      for (const corner of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const) {
        expect(found[corner], `${corner} colour is in the rendered output`).not.toBeNull();
        expect(Math.abs(found[corner]![0] - want[corner][0]), `${corner} x`).toBeLessThan(0.012);
        expect(Math.abs(found[corner]![1] - want[corner][1]), `${corner} y`).toBeLessThan(0.012);
      }
    });
  }

  test('dragging the stamp moves it in the output by the same amount', async ({ page }) => {
    await openSign(page, FIXTURE.pdfRotate90);
    await addUploadedSignature(page, FIXTURE.signMarker);
    await setStampMm(page, { x: 60, y: 60, width: 70 });
    const before = await stampViewRect(page);

    const stamp = page.getByTestId('overlay-item');
    const box = (await stamp.boundingBox())!;
    const canvas = (await page.getByTestId('page-canvas').boundingBox())!;
    const [dx, dy] = [90, -45];
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
    await page.mouse.up();

    const after = await stampViewRect(page);
    expectSameRect(
      after,
      { ...before, x: before.x + dx / canvas.width, y: before.y + dy / canvas.height },
      TOLERANCE,
      'box after the drag',
    );

    const bytes = await signAndDownload(page);
    const [image] = await readDrawnImages(bytes, 0);
    expectSameRect(image.rect, after, TOLERANCE, 'image in the file');
    expectUpright(image, after, TOLERANCE);
  });

  test('pulling a corner resizes it in the output and keeps its shape', async ({ page }) => {
    await openSign(page, FIXTURE.pdfCropOffset);
    await addUploadedSignature(page, FIXTURE.signMarker);
    await setStampMm(page, { x: 30, y: 40, width: 50 });
    const before = await stampViewRect(page);

    const handle = page.getByTestId('overlay-handle-bottom-right');
    const grip = (await handle.boundingBox())!;
    const canvas = (await page.getByTestId('page-canvas').boundingBox())!;
    const pull = 60;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + pull, grip.y + grip.height / 2 + pull, { steps: 10 });
    await page.mouse.up();

    const after = await stampViewRect(page);
    // The opposite corner stayed put, and the box grew.
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
    // The box is three times wider than tall, so 60px down is the bigger pull.
    expect(after.height).toBeCloseTo(before.height + pull / canvas.height, 2);
    // Same shape on screen (3:1 in pixels) as before.
    const shape = (r: ViewRect) => (r.width * canvas.width) / (r.height * canvas.height);
    expect(shape(after)).toBeCloseTo(shape(before), 1);
    expect(shape(after)).toBeCloseTo(3, 1);

    const bytes = await signAndDownload(page);
    const [image] = await readDrawnImages(bytes, 0);
    expectSameRect(image.rect, after, TOLERANCE, 'image in the file');
    expectUpright(image, after, TOLERANCE);
  });

  test('"Smaller", "Larger" and "Duplicate" do what they say, in the output', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addUploadedSignature(page, FIXTURE.signMarker);
    await setStampMm(page, { x: 50, y: 50, width: 60 });
    const start = await stampViewRect(page);

    await page.getByTestId('stamp-larger').click();
    const larger = await stampViewRect(page);
    expect(larger.width / start.width).toBeCloseTo(1.1, 2);
    // It grows about its centre.
    expect(larger.x + larger.width / 2).toBeCloseTo(start.x + start.width / 2, 3);

    await page.getByTestId('stamp-smaller').click();
    await page.getByTestId('stamp-smaller').click();
    const smaller = await stampViewRect(page);
    expect(smaller.width / start.width).toBeCloseTo(1 / 1.1, 2);

    await page.getByTestId('stamp-duplicate').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(2);
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');
    const copy = await stampViewRect(page);
    expect(copy.width).toBeCloseTo(smaller.width, 3);
    expect(copy.x).toBeGreaterThan(smaller.x);

    const bytes = await signAndDownload(page);
    const images = await readDrawnImages(bytes, 0);
    expect(images.length).toBe(2);
    expectSameRect(images[0].rect, smaller, TOLERANCE, 'the original');
    expectSameRect(images[1].rect, copy, TOLERANCE, 'the duplicate');
  });

  test('"Copy to all pages" puts it in the same place on every page, storing the image once', async ({ page }) => {
    await openSign(page, FIXTURE.pdf3page);
    await addUploadedSignature(page, FIXTURE.signMarker);
    await setStampMm(page, { x: 110, y: 230, width: 55 });
    const shown = await stampViewRect(page);

    await page.getByTestId('place-all-pages').click();
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');
    for (const n of [1, 2, 3]) await expect(page.getByTestId(`rail-badge-${n}`)).toBeVisible();
    // Pressing it again replaces the copies; it does not stack three more.
    await page.getByTestId('place-all-pages').click();
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');

    // The copy really is on the other pages, in the same spot.
    await page.getByTestId('page-next').click();
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 2 of 3');
    expectSameRect(await stampViewRect(page, page.getByTestId('overlay-item')), shown, 0.002, 'copy on page 2');

    const bytes = await signAndDownload(page);
    expect(await countPdfPagesStrict(bytes)).toBe(3);
    for (const i of [0, 1, 2]) {
      const images = await readDrawnImages(bytes, i);
      expect(images.length, `page ${i + 1} has the stamp`).toBe(1);
      expectSameRect(images[0].rect, shown, TOLERANCE, `page ${i + 1}`);
      expectUpright(images[0], shown, TOLERANCE);
    }
    expect(await countStoredImages(bytes), 'the image is stored once, not once per page').toBe(1);
  });

  test('Remove, Undo and Redo are reflected in the output', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addUploadedSignature(page, FIXTURE.signMarker);
    await page.getByTestId('stamp-date').click();
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');
    await expect(page.getByTestId('undo')).toBeEnabled();
    await expect(page.getByTestId('redo')).toBeDisabled();

    // Remove the signature (select it first: the date is the selected one).
    await page.locator('[data-testid="overlay-item"][data-kind="signature"]').click();
    await page.getByTestId('overlay-remove').click();
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');
    await expect(page.locator('[data-testid="overlay-item"][data-kind="signature"]')).toHaveCount(0);

    // Undo brings it back; redo takes it away again; the keyboard does the same.
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');
    await page.getByTestId('redo').click();
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');
    await page.getByTestId('ws-stage').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');

    // Final state: the date only. The output has the date text and no image.
    const note = (await page.getByTestId('add-note').textContent()) ?? '';
    const dateText = note.replace(/^The date stamp reads /, '').replace(/\.$/, '');
    const bytes = await signAndDownload(page);
    expect((await readDrawnImages(bytes, 0)).length, 'the removed signature is not in the file').toBe(0);
    expect((await readPdfContentStreams(bytes, 0)).join('\n')).not.toMatch(/\/\S+\s+Do\b/);
    expect(await extractPdfText(bytes, 0), 'the date is').toContain(dateText);
  });

  test('undo all the way back leaves nothing to sign', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addTypedSignature(page);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Add your signature to the page first');
    await page.getByTestId('redo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
    await expect(page.getByTestId('tool-action')).toBeEnabled();
  });

  test('initials and the date land where they are shown', async ({ page }) => {
    await openSign(page, FIXTURE.pdfRotate90);
    await addTypedSignature(page, 'Ada Lovelace');

    await page.getByTestId('initials-input').fill('AL');
    await page.getByTestId('stamp-initials').click();
    await page.getByTestId('stamp-date').click();
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');

    const item = (kind: string) => page.locator(`[data-testid="overlay-item"][data-kind="${kind}"]`);
    const signature = await stampViewRect(page, item('signature'));
    const initials = await stampViewRect(page, item('initials'));
    const date = await stampViewRect(page, item('date'));
    const note = (await page.getByTestId('add-note').textContent()) ?? '';
    const dateText = note.replace(/^The date stamp reads /, '').replace(/\.$/, '');
    expect(dateText.length).toBeGreaterThan(5);

    const bytes = await signAndDownload(page);

    // Two images: the signature and the initials, each in its own box.
    const images = await readDrawnImages(bytes, 0);
    expect(images.length).toBe(2);
    const nearest = (rect: ViewRect) =>
      [...images].sort((a, b) => Math.abs(a.rect.x - rect.x) - Math.abs(b.rect.x - rect.x))[0];
    expectSameRect(nearest(signature).rect, signature, TOLERANCE, 'signature');
    expectUpright(nearest(signature), signature, TOLERANCE);
    expectSameRect(nearest(initials).rect, initials, TOLERANCE, 'initials');
    expectUpright(nearest(initials), initials, TOLERANCE);

    // The date is real text. Its baseline, height and width — measured with
    // pdf-lib's own Helvetica metrics — fill the box that was on screen, and on
    // this /Rotate 90 page it still reads left to right.
    expect(await extractPdfText(bytes, 0)).toContain(dateText);
    // The page's own text is drawn first; the date was appended, so it is last.
    const texts = await readDrawnText(bytes, 0);
    expect(texts.length).toBeGreaterThan(0);
    const text = texts[texts.length - 1];
    const helvetica = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const widthEm = helvetica.widthOfTextAtSize(dateText, 1);
    const alongX = text.along[0] - text.origin[0];
    const alongY = text.along[1] - text.origin[1];
    const upY = text.up[1] - text.origin[1];
    expect(alongX, 'reads left to right').toBeGreaterThan(0);
    expect(Math.abs(alongY), 'and level').toBeLessThan(0.001);
    expect(upY, 'the right way up').toBeLessThan(0);
    const drawn: ViewRect = {
      x: text.origin[0],
      y: text.origin[1] + upY * 0.718,
      width: alongX * widthEm,
      height: -upY * 0.925,
    };
    expectSameRect(drawn, date, TOLERANCE, 'date text');
  });

  test('redrawing the signature updates every stamp that shows it', async ({ page }) => {
    await openSign(page, FIXTURE.pdf3page);
    await addTypedSignature(page, 'Ada Lovelace');
    await page.getByTestId('place-all-pages').click();
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');
    const before = await stampViewRect(page);

    await page.getByTestId('change-signature').click();
    await chooseSignaturePicture(page, FIXTURE.signMarker);
    await page.getByTestId('signature-view-original').click();
    await page.getByTestId('use-signature').click();
    await expect(page.getByTestId('signature-creator')).toHaveCount(0);

    // Still three stamps, same width and centre, now with the new image's 3:1 shape.
    await expect(page.getByTestId('placed-count')).toHaveText('3 stamps placed');
    const canvas = (await page.getByTestId('page-canvas').boundingBox())!;
    await expect
      .poll(async () => {
        const r = await stampViewRect(page, page.getByTestId('overlay-item'));
        return (r.width * canvas.width) / (r.height * canvas.height);
      })
      .toBeCloseTo(3, 1);
    const after = await stampViewRect(page, page.getByTestId('overlay-item'));
    expect(after.width).toBeCloseTo(before.width, 3);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 2);

    const bytes = await signAndDownload(page);
    for (const i of [0, 1, 2]) {
      const images = await readDrawnImages(bytes, i);
      expect(images.length).toBe(1);
      expectSameRect(images[0].rect, after, TOLERANCE, `page ${i + 1}`);
    }
    expect(await countStoredImages(bytes), 'only the new image is in the file').toBe(1);
  });

  test('a click on the page moves a new stamp there; once moved, a click only deselects', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addTypedSignature(page);
    const layer = page.getByTestId('overlay-layer');
    const size = (await layer.boundingBox())!;

    await layer.click({ position: { x: size.width * 0.3, y: size.height * 0.25 } });
    let rect = await stampViewRect(page);
    expect(rect.x + rect.width / 2).toBeCloseTo(0.3, 2);
    expect(rect.y + rect.height / 2).toBeCloseTo(0.25, 2);
    // Still "new": a second click corrects the first.
    await layer.click({ position: { x: size.width * 0.6, y: size.height * 0.5 } });
    rect = await stampViewRect(page);
    expect(rect.x + rect.width / 2).toBeCloseTo(0.6, 2);

    // A real move ends that: the next click on the page lets go of the stamp.
    await page.getByTestId('overlay-item').focus();
    await page.keyboard.press('ArrowRight');
    const moved = await stampViewRect(page);
    await expect(page.getByTestId('overlay-hint')).toHaveCount(0);
    await layer.click({ position: { x: size.width * 0.2, y: size.height * 0.9 } });
    await expect(page.getByTestId('overlay-item')).toHaveAttribute('data-selected', 'false');
    expectSameRect(await stampViewRect(page, page.getByTestId('overlay-item')), moved, 0.001, 'unmoved');

    const bytes = await signAndDownload(page);
    const [image] = await readDrawnImages(bytes, 0);
    expectSameRect(image.rect, moved, TOLERANCE, 'image in the file');
  });

  test('the keyboard alone can move, resize and remove a stamp', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addTypedSignature(page);
    const stamp = page.getByTestId('overlay-item');
    await stamp.focus();
    const start = await stampViewRect(page);

    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    let rect = await stampViewRect(page);
    expect(rect.x - start.x).toBeCloseTo(4 / 200, 3);
    // Up by ten steps of the same on-screen distance: 10/200 of the page WIDTH.
    expect(start.y - rect.y).toBeCloseTo((10 / 200) * (612 / 792), 3);
    await expect(page.getByTestId('stamp-announce')).toContainText('Signature at');

    await page.keyboard.press('+');
    rect = await stampViewRect(page);
    expect(rect.width / start.width).toBeCloseTo(1.05, 2);

    const bytes = await signAndDownload(page);
    const [image] = await readDrawnImages(bytes, 0);
    expectSameRect(image.rect, rect, TOLERANCE, 'image in the file');

    await page.getByTestId('edit-again').click();
    await stamp.focus();
    await page.keyboard.press('Delete');
    await expect(stamp).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toBeDisabled();
  });

  test('after signing, the page shown is the output; "Make changes" goes back and drops the result', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addUploadedSignature(page, FIXTURE.signMarker);
    await setStampMm(page, { x: 40, y: 60, width: 60 });
    const first = await stampViewRect(page);
    await signAndDownload(page);

    // The document pane is the signed file, and says so.
    await waitForOutputPage(page);
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);
    await expect(page.getByTestId('result-panel')).toContainText('Signed and ready');
    expect((await findMarkerInViewer(page)).topLeft, 'the marker is in the rendered output').not.toBeNull();

    // Before: the original, without the stamp.
    await page.getByTestId('compare-before').click();
    await expect(page.getByTestId('output-caption')).toHaveText('Before — your original');
    await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible();
    await expect(page.getByTestId('page-image')).toHaveAttribute('alt', 'Page 1');
    expect((await findMarkerInViewer(page)).topLeft, 'the original has no marker').toBeNull();
    await page.getByTestId('compare-after').click();
    await waitForOutputPage(page);

    // Make changes: back to editing, the stamps still there, the result gone.
    await page.getByTestId('edit-again').click();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('result-panel')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toBeEnabled();
    await expect(page.getByTestId('tool-action')).toBeFocused();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
    expectSameRect(await stampViewRect(page, page.getByTestId('overlay-item')), first, 0.001, 'stamp after going back');

    // Move it and sign again: the new file has the new position.
    await page.getByTestId('overlay-item').click();
    await setStampMm(page, { x: 100, y: 180 });
    const second = await stampViewRect(page);
    expect(second.x).toBeGreaterThan(first.x + 0.2);
    const bytes = await signAndDownload(page);
    const images = await readDrawnImages(bytes, 0);
    expect(images.length, 'signed from the original, not on top of the first result').toBe(1);
    expectSameRect(images[0].rect, second, TOLERANCE, 'image in the second file');
  });
});

test.describe('Sign PDF — dates in a locale Helvetica cannot write', () => {
  // Arabic-Egypt formats dates with Arabic-Indic digits, which the standard
  // Helvetica font cannot encode: drawing them made pdf-lib throw.
  test.use({ locale: 'ar-EG' });

  test('the date stamp falls back to ISO and the file is still signed', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await addTypedSignature(page);
    const iso = await page.evaluate(() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });
    // The browser's own format really is not ASCII here — otherwise this proves nothing.
    expect(await page.evaluate(() => /^[\x20-\x7e]+$/.test(new Date().toLocaleDateString()))).toBe(false);
    await expect(page.getByTestId('add-note')).toHaveText(`The date stamp reads ${iso}.`);

    await page.getByTestId('stamp-date').click();
    await expect(page.getByTestId('placed-count')).toHaveText('2 stamps placed');
    const bytes = await signAndDownload(page);
    expect(await extractPdfText(bytes, 0)).toContain(iso);
  });
});
