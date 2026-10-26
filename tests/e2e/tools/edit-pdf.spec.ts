import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, countPdfPagesStrict, readPdfAnnotationSubtypes } from '../helpers/harness';
import { expectSameRect, type ViewRect } from '../helpers/sign';
import { expectHeicPhotoOnPage } from '../helpers/heic-photo';
import {
  addObject,
  dragCorner,
  dragObject,
  objectViewRect,
  openEdit,
  readAnnotations,
  readDrawnObjects,
  readExtGStateAlpha,
  saveAndDownload,
  selectedObject,
  setField,
  type DrawnObject,
  type EditKind,
} from '../helpers/edit-pdf';

/**
 * Edit PDF: everything a visitor adds can be sized — by a corner handle, by the
 * millimetre fields and (for text) by its font size — and the downloaded file
 * has each object exactly where its box was on screen.
 *
 * Every assertion about size and position is made on the DOWNLOADED file: the
 * object's frame is read out of the page content and mapped to the displayed
 * page with pdf.js (helpers/edit-pdf.ts). Tolerance: 0.5% of the page.
 */

const TOLERANCE = 0.005;
/** The one-page fixture is US Letter: 612 × 792 pt. */
const PAGE_MM = { width: 215.9, height: 279.4 };

/** A rough fingerprint of each kind's drawing inside its frame, to match frames to objects. */
const BODY: Record<EditKind, RegExp> = {
  text: /Tf[\s\S]*Tj/,
  image: /Do/,
  rect: /re\s+S/,
  ellipse: / c\s+S/,
  line: / l\s+S/,
  arrow: / l\s+S[\s\S]* l\s+S/,
  draw: / l\s+[\d.-]+ [\d.-]+ l/,
  highlight: /re\s+f/,
  whiteout: /1 1 1 rg/,
  stamp: /Tz/,
};

function expectDrawn(drawn: DrawnObject, kind: EditKind, rect: ViewRect, what: string) {
  expect(drawn.body, `${what} is drawn as a ${kind}`).toMatch(BODY[kind]);
  expectSameRect(drawn.rect, rect, TOLERANCE, what);
}

async function sizeDiffers(a: ViewRect, b: ViewRect) {
  expect(Math.abs(a.width - b.width) + Math.abs(a.height - b.height), 'the size changed').toBeGreaterThan(0.01);
}

test.describe('Edit PDF', () => {
  test('page loads with the H1 and the dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/edit-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Edit PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('the workspace opens with a labelled palette and says what to do first', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await openEdit(page, FIXTURE.pdf3page);
    for (const [kind, label] of [
      ['text', 'Text'],
      ['image', 'Image'],
      ['rect', 'Rectangle'],
      ['ellipse', 'Ellipse'],
      ['line', 'Line'],
      ['arrow', 'Arrow'],
      ['draw', 'Draw'],
      ['highlight', 'Highlight'],
      ['whiteout', 'Whiteout'],
      ['stamp', 'Stamp'],
    ]) {
      await expect(page.getByTestId(`add-${kind}`)).toHaveText(label);
    }
    await expect(page.getByTestId('step-prompt')).toHaveText('Choose what to add to this page on the right.');
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Add something to a page first');

    await addObject(page, 'text');
    await expect(page.getByTestId('step-prompt')).toHaveText(
      'Drag to move it, pull a corner to resize it, or type its exact size on the right.',
    );
    await expect(selectedObject(page).getByTestId('overlay-hint')).toHaveText('Drag to move · corners to resize');
    await expect(page.getByTestId('tool-action')).toBeEnabled();
    const bytes = await saveAndDownload(page);
    expect(await countPdfPagesStrict(bytes)).toBe(3);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  // Each kind: one object resized with the corner handle, a second with the
  // millimetre fields; both are read back out of the file.
  for (const kind of ['text', 'image', 'rect', 'ellipse', 'line', 'arrow', 'draw', 'highlight', 'whiteout', 'stamp'] as const) {
    test(`${kind}: resized by the handle and by the fields, and saved at exactly that size`, async ({ page }) => {
      await openEdit(page, FIXTURE.pdf1page);

      const first = await addObject(page, kind, FIXTURE.png);
      const added = await objectViewRect(first);
      await dragCorner(page, 60, 40);
      const byHandle = await objectViewRect(first);
      await sizeDiffers(added, byHandle);
      // Pictures, stamps and text keep their shape; shapes are free.
      const shape = (r: ViewRect) => r.width / r.height;
      if (kind === 'image' || kind === 'stamp' || kind === 'text') {
        expect(shape(byHandle)).toBeCloseTo(shape(added), 1);
      }

      const second = await addObject(page, kind, FIXTURE.png);
      await dragObject(page, -120, 120);
      await setField(page, 'object-width', 70);
      if (kind !== 'text' && kind !== 'image' && kind !== 'stamp') await setField(page, 'object-height', 25);
      await setField(page, 'object-x', 20);
      await setField(page, 'object-y', 200);
      const byFields = await objectViewRect(second);
      expect(byFields.width).toBeCloseTo(70 / PAGE_MM.width, 2);
      expect(byFields.x).toBeCloseTo(20 / PAGE_MM.width, 2);
      expect(byFields.y).toBeCloseTo(200 / PAGE_MM.height, 2);
      if (kind !== 'text' && kind !== 'image' && kind !== 'stamp') expect(byFields.height).toBeCloseTo(25 / PAGE_MM.height, 2);

      const drawn = await readDrawnObjects(await saveAndDownload(page));
      expect(drawn).toHaveLength(2);
      expectDrawn(drawn[0], kind, byHandle, `${kind} resized by its handle`);
      expectDrawn(drawn[1], kind, byFields, `${kind} sized with the fields`);
    });
  }

  test('text: the font size field, its buttons and a corner pull all change the font size in the file', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf1page);
    await addObject(page, 'text');
    await page.getByTestId('object-text').fill('Invoice total');
    await page.getByTestId('object-colour').fill('#ff0000');
    // The opacity slider by keyboard: 100% down ten 5% steps to 50%.
    await page.getByTestId('object-opacity').focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
    await expect(page.getByText('Opacity 50%')).toBeVisible();
    await setField(page, 'font-size', 30);
    await expect(page.getByTestId('font-size')).toHaveValue('30');
    await page.getByTestId('font-size-up').click();
    await page.getByTestId('font-size-up').click();
    await page.getByTestId('font-size-down').click();
    await expect(page.getByTestId('font-size')).toHaveValue('31');
    const at31 = await objectViewRect(selectedObject(page));

    // Bounds: 6–144 pt.
    await setField(page, 'font-size', 2);
    await expect(page.getByTestId('font-size')).toHaveValue('6');
    await setField(page, 'font-size', 31);
    expectSameRect(await objectViewRect(selectedObject(page)), at31, 0.001, 'back at 31 pt');

    // A second text box, made larger with its corner: the font follows the box.
    await addObject(page, 'text');
    await dragObject(page, 0, 150);
    const before = await objectViewRect(selectedObject(page));
    const startSize = Number(await page.getByTestId('font-size').inputValue());
    await dragCorner(page, 80, 0);
    const after = await objectViewRect(selectedObject(page));
    const pulled = Number(await page.getByTestId('font-size').inputValue());
    expect(pulled).toBeCloseTo(startSize * (after.width / before.width), 0);

    const bytes = await saveAndDownload(page);
    const drawn = await readDrawnObjects(bytes);
    expect(drawn).toHaveLength(2);
    expect(drawn[0].fontSize).toBe(31);
    expectDrawn(drawn[0], 'text', at31, 'text at 31 pt');
    expect(drawn[0].body).toContain('<496E766F69636520746F74616C> Tj'); // "Invoice total"
    // Red, at 50% opacity: the fill colour and the ExtGState the frame selects.
    expect(drawn[0].body).toMatch(/\b1 0 0 rg\b/);
    const gs = drawn[0].body.match(/\/(\S+) gs/)?.[1];
    expect(gs, 'the red text selects a graphics state').toBeTruthy();
    expect(await readExtGStateAlpha(bytes, gs!)).toBe(0.5);
    // The colour carries on to the next text box added.
    expect(drawn[1].body).toMatch(/\b1 0 0 rg\b/);
    expect(drawn[1].fontSize!).toBeCloseTo(pulled, 0);
    expectDrawn(drawn[1], 'text', after, 'text pulled larger');
  });

  test('Keep proportions: off lets a picture stretch, on keeps a rectangle’s shape', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf1page);
    await addObject(page, 'image', FIXTURE.png);
    await expect(page.getByTestId('object-lock')).toBeChecked();
    await page.getByTestId('object-lock').uncheck();
    const square = await objectViewRect(selectedObject(page));
    await setField(page, 'object-height', 30);
    const stretched = await objectViewRect(selectedObject(page));
    expect(stretched.width).toBeCloseTo(square.width, 3);
    expect(stretched.height).toBeCloseTo(30 / PAGE_MM.height, 2);

    await addObject(page, 'rect');
    await expect(page.getByTestId('object-lock')).not.toBeChecked();
    await page.getByTestId('object-lock').check();
    const rect = await objectViewRect(selectedObject(page));
    await setField(page, 'object-width', 100);
    const kept = await objectViewRect(selectedObject(page));
    expect(kept.width / kept.height).toBeCloseTo(rect.width / rect.height, 2);
    await dragCorner(page, 40, -10);
    const pulled = await objectViewRect(selectedObject(page));
    expect(pulled.width / pulled.height).toBeCloseTo(rect.width / rect.height, 2);

    const drawn = await readDrawnObjects(await saveAndDownload(page));
    expectDrawn(drawn[0], 'image', stretched, 'stretched picture');
    expectDrawn(drawn[1], 'rect', pulled, 'rectangle with proportions kept');
  });

  test('undo and redo a resize, and remove; the file has what is on screen', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf1page);
    await addObject(page, 'ellipse');
    const original = await objectViewRect(selectedObject(page));
    await dragCorner(page, 70, 50);
    const resized = await objectViewRect(selectedObject(page));
    await sizeDiffers(original, resized);

    await page.getByTestId('undo').click();
    expectSameRect(await objectViewRect(page.getByTestId('overlay-item')), original, 0.001, 'after undo');
    await page.getByTestId('redo').click();
    expectSameRect(await objectViewRect(page.getByTestId('overlay-item')), resized, 0.001, 'after redo');
    // Ctrl+Z / Ctrl+Shift+Z do the same.
    await page.getByTestId('page-viewer').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    expectSameRect(await objectViewRect(page.getByTestId('overlay-item')), original, 0.001, 'after Ctrl+Z');
    await page.keyboard.press('Control+Shift+z');
    expectSameRect(await objectViewRect(page.getByTestId('overlay-item')), resized, 0.001, 'after Ctrl+Shift+Z');

    // A stamp added and removed again leaves no trace.
    await addObject(page, 'stamp');
    await page.getByTestId('overlay-remove').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);

    const drawn = await readDrawnObjects(await saveAndDownload(page));
    expect(drawn).toHaveLength(1);
    expectDrawn(drawn[0], 'ellipse', resized, 'ellipse after redo');
  });

  test('Smaller and Larger resize without a drag', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf1page);
    await addObject(page, 'image', FIXTURE.png);
    const start = await objectViewRect(selectedObject(page));
    await page.getByTestId('object-larger').click();
    await page.getByTestId('object-larger').click();
    await page.getByTestId('object-smaller').click();
    const end = await objectViewRect(selectedObject(page));
    expect(end.width / start.width).toBeCloseTo(1.1, 2);
    const drawn = await readDrawnObjects(await saveAndDownload(page));
    expectDrawn(drawn[0], 'image', end, 'picture after Larger, Larger, Smaller');
  });

  test('an iPhone HEIC photo is added upright at its own size and is the photo in the file', async ({ page }) => {
    // HEIC is decoded by a WASM library where the browser cannot do it itself.
    test.slow();
    const diag = new PageDiagnostics(page);
    await openEdit(page, FIXTURE.pdf1page);
    await expect(page.getByTestId('add-image-input')).toHaveAttribute('accept', /image\/heic.*\.heic/);
    await page.getByTestId('add-image-input').setInputFiles(FIXTURE.heic);
    await expect(selectedObject(page)).toHaveAttribute('data-kind', 'image', { timeout: 60_000 });
    await expect(page.getByTestId('image-reading')).toHaveCount(0);
    const shown = await objectViewRect(selectedObject(page));
    // Landscape on the page, as the photo is.
    expect((shown.width * PAGE_MM.width) / (shown.height * PAGE_MM.height)).toBeCloseTo(1.5, 1);

    const bytes = await saveAndDownload(page);
    const drawn = await readDrawnObjects(bytes);
    expect(drawn).toHaveLength(1);
    expectDrawn(drawn[0], 'image', shown, 'HEIC photo');
    // One 600 × 400 image, and the rendered page shows the photo where the box was.
    const placed = await expectHeicPhotoOnPage(bytes);
    expectSameRect(placed, shown, TOLERANCE, 'photo on the rendered page');
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  for (const [name, pdf] of [
    ['/Rotate 90', FIXTURE.pdfRotate90],
    ['offset crop box', FIXTURE.pdfCropOffset],
  ] as const) {
    test(`on a ${name} page every object lands where it was shown, in both save modes`, async ({ page }) => {
      await openEdit(page, pdf);
      const shown: { kind: EditKind; rect: ViewRect }[] = [];
      for (const kind of ['text', 'image', 'rect', 'arrow', 'stamp'] as const) {
        await addObject(page, kind, FIXTURE.png);
        await dragObject(page, -40 + shown.length * 25, -100 + shown.length * 60);
        await dragCorner(page, 30, 20);
        shown.push({ kind, rect: await objectViewRect(selectedObject(page)) });
      }

      const flat = await readDrawnObjects(await saveAndDownload(page));
      expect(flat).toHaveLength(shown.length);
      shown.forEach((s, i) => expectDrawn(flat[i], s.kind, s.rect, `${s.kind} on the ${name} page`));

      // The same objects as annotations: each /Rect covers the same box.
      await page.getByTestId('edit-again').click();
      await page.getByTestId('save-mode-annotations').click();
      const annots = await readAnnotations(await saveAndDownload(page));
      expect(annots.map((a) => a.subtype)).toEqual(['FreeText', 'Stamp', 'Square', 'Line', 'Stamp']);
      shown.forEach((s, i) => expectSameRect(annots[i].rect, s.rect, TOLERANCE, `${s.kind} annotation on the ${name} page`));
    });
  }

  test('Part of the page leaves no annotations; Separate annotations keeps them', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf3page);
    await addObject(page, 'text');
    const flat = await saveAndDownload(page);
    expect(await readPdfAnnotationSubtypes(flat)).toEqual([]);

    await page.getByTestId('edit-again').click();
    await page.getByTestId('save-mode-annotations').click();
    await expect(page.getByTestId('save-mode-note')).toContainText('other PDF apps can select, move or delete');
    const kept = await saveAndDownload(page);
    expect(await countPdfPagesStrict(kept)).toBe(3);
    expect(await readPdfAnnotationSubtypes(kept)).toContain('FreeText');
  });

  test('objects go on the page being shown', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf3page);
    await page.getByTestId('page-next').click();
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 2 of 3');
    await addObject(page, 'rect');
    const rect = await objectViewRect(selectedObject(page));
    await expect(page.getByTestId('rail-badge-2')).toBeVisible();
    const bytes = await saveAndDownload(page);
    expect(await readDrawnObjects(bytes, 0)).toHaveLength(0);
    const drawn = await readDrawnObjects(bytes, 1);
    expectDrawn(drawn[0], 'rect', rect, 'rectangle on page 2');
  });

  test('the keyboard moves, resizes and removes; plus and minus change a text box’s font size', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf1page);
    const text = await addObject(page, 'text');
    const startSize = Number(await page.getByTestId('font-size').inputValue());
    await text.focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    const grown = Number(await page.getByTestId('font-size').inputValue());
    expect(grown).toBeCloseTo(startSize * 1.05 * 1.05, 0);
    await page.keyboard.press('ArrowDown');
    const shown = await objectViewRect(text);

    const rect = await addObject(page, 'rect');
    await rect.focus();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);

    const drawn = await readDrawnObjects(await saveAndDownload(page));
    expect(drawn).toHaveLength(1);
    expect(drawn[0].fontSize!).toBeCloseTo(grown, 0);
    expectDrawn(drawn[0], 'text', shown, 'text grown with the keyboard');
  });
});
