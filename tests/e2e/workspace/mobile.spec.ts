import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { openSign, readDrawnImages, signAndDownload, stampViewRect, expectSameRect } from '../helpers/sign';
import { expectDownload, pngSize, readZipEntries } from '../helpers/harness';
import { openImages, previewPages, readOutputPages, expectPreviewMatchesFile } from '../helpers/image-to-pdf';
import { openEdit, objectViewRect, readDrawnObjects, selectedObject } from '../helpers/edit-pdf';
import { openCompress, chooseLevel, settledPreview } from '../helpers/compress-pdf';
import { openPdfToImage, openPreview } from '../helpers/pdf-to-image';
import { drawMark, markViewRect, openOptions as openRedactOptions, openRedact, pageText } from '../helpers/redact-pdf';
import { MIGRATED } from './migrated';

/**
 * The workspace on a phone (375 × 667, touch).
 *
 * Runs in the `mobile` project only. After a file is added there must be no
 * sideways scroll, the document must keep at least 40% of the screen, and the
 * action bar must be on it. Options open as a panel that pushes nothing off the
 * screen that the visitor needs: the document stays visible above it.
 */
test.use({ viewport: { width: 375, height: 667 } });

interface Layout {
  overflowX: number;
  viewport: { width: number; height: number };
  stage: DOMRect | null;
  action: DOMRect | null;
  controls: DOMRect | null;
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const rect = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? (el.getBoundingClientRect().toJSON() as DOMRect) : null;
    };
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      stage: rect('ws-stage'),
      action: rect('action-bar'),
      controls: rect('ws-controls'),
    };
  });
}

/** How much of a box is on screen, in pixels of height. */
const visibleHeight = (r: DOMRect, viewportHeight: number) =>
  Math.max(0, Math.min(r.bottom, viewportHeight) - Math.max(r.top, 0));

function expectPhoneLayout(l: Layout, when: string) {
  expect(l.overflowX, `${when}: no horizontal overflow`).toBeLessThanOrEqual(0);
  expect(l.stage, `${when}: stage`).not.toBeNull();
  expect(l.action, `${when}: action bar`).not.toBeNull();
  // The document pane is at least 40% of the screen tall…
  expect(l.stage!.height, `${when}: stage height`).toBeGreaterThanOrEqual(l.viewport.height * 0.4 - 1);
  // …and it is really on screen, not merely that tall somewhere above the fold.
  expect(visibleHeight(l.stage!, l.viewport.height), `${when}: stage on screen`).toBeGreaterThanOrEqual(
    l.viewport.height * 0.25,
  );
  // The action bar is wholly inside the viewport.
  expect(l.action!.top, `${when}: action bar top`).toBeGreaterThanOrEqual(0);
  expect(l.action!.bottom, `${when}: action bar bottom`).toBeLessThanOrEqual(l.viewport.height + 0.5);
  expect(l.action!.left, `${when}: action bar left`).toBeGreaterThanOrEqual(0);
  expect(l.action!.right, `${when}: action bar right`).toBeLessThanOrEqual(l.viewport.width + 0.5);
}

for (const tool of MIGRATED) {
  test.describe(`Workspace on a phone — ${tool.name}`, () => {
    test('after upload: no sideways scroll, the document keeps its share, the action bar is on screen', async ({ page }) => {
      await tool.enter(page);
      expectPhoneLayout(await layout(page), 'after upload');

      // "Options" is a real toggle, and neither position hides the document or the action.
      const toggle = page.getByTestId('options-toggle');
      await expect(toggle).toBeVisible();
      const wasOpen = (await toggle.getAttribute('aria-expanded')) === 'true';
      await toggle.tap();
      await expect(toggle).toHaveAttribute('aria-expanded', wasOpen ? 'false' : 'true');
      expectPhoneLayout(await layout(page), 'options toggled');
      await toggle.tap();
      await expect(toggle).toHaveAttribute('aria-expanded', wasOpen ? 'true' : 'false');
      expectPhoneLayout(await layout(page), 'options toggled back');
    });

    test('the action is one tap away once the tool is ready', async ({ page }) => {
      await tool.enter(page);
      await tool.makeReady?.(page);
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled();
      expectPhoneLayout(await layout(page), 'ready');
      await action.tap();
      await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
      expectPhoneLayout(await layout(page), 'done');
    });
  });
}

test.describe('Image to PDF on a phone', () => {
  test('pages two across, more images from the top bar, options without losing the pages', async ({ page }) => {
    await openImages(page, [FIXTURE.jpg, FIXTURE.jpg2]);

    // Two pages side by side, both on screen, each with its buttons in reach.
    const cards = page.getByTestId('file-card');
    const [first, second] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
    expect(Math.abs(first.y - second.y)).toBeLessThan(2);
    expect(second.x).toBeGreaterThan(first.x + first.width - 1);
    await expect(page.getByTestId('grid-size-m')).toHaveAttribute('aria-pressed', 'true');
    for (const id of ['page-reorder', 'page-open', 'file-remove']) {
      const button = (await cards.first().getByTestId(id).boundingBox())!;
      expect(Math.min(button.width, button.height), `${id} is big enough to tap`).toBeGreaterThanOrEqual(28);
    }
    await expect(page.getByTestId('step-prompt')).toContainText('Drag pages by their handle to change their order');

    // The options are closed, so adding images is in the top bar.
    await expect(page.getByTestId('ws-controls')).toBeHidden();
    await expect(page.getByTestId('add-files')).toBeVisible();
    await page.getByTestId('add-files-input').setInputFiles(FIXTURE.png);
    await expect(page.getByTestId('output-page')).toHaveCount(3);
    await expect(page.getByTestId('file-info')).toContainText('3 images');
    expectPhoneLayout(await layout(page), 'three images');

    // Options open under the pages; a change there shows in the pages above.
    await page.getByTestId('options-toggle').tap();
    await expect(page.getByTestId('ws-controls')).toBeVisible();
    await page.getByTestId('i2p-size-fit').tap();
    await expect(page.getByTestId('page-grid-caption')).toHaveText('Fit Image · each page is exactly its image');
    expect((await previewPages(page)).map((p) => [p.pageW, p.pageH])).toEqual([[1200, 800], [900, 1200], [800, 800]]);
    expectPhoneLayout(await layout(page), 'options open');

    // One tap makes the PDF, and it is what the pages showed.
    const shown = await previewPages(page);
    await page.getByTestId('tool-action').tap();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').tap());
    expectPreviewMatchesFile(shown, await readOutputPages(bytes));
    expectPhoneLayout(await layout(page), 'done');
  });

  test('a page opens large and closes again with a tap', async ({ page }) => {
    await openImages(page, [FIXTURE.jpg, FIXTURE.jpg2]);
    await page.getByTestId('page-open').first().tap();
    const dialog = page.getByTestId('page-preview-dialog');
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect((await dialog.getByTestId('output-page').boundingBox())!.width).toBeGreaterThan(250);
    await page.getByTestId('page-preview-next').tap();
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 2 of 2 · photo-2.jpg');
    await page.getByTestId('page-preview-close').tap();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('Sign PDF on a phone', () => {
  test('sign with taps alone: make the signature, place it, resize it with the buttons', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);

    // The options open by themselves with the signature maker, and the page is still there above.
    await expect(page.getByTestId('options-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('signature-creator')).toBeVisible();
    await expect(page.getByTestId('step-prompt')).toHaveText('Create your signature below.');
    const withPanel = await layout(page);
    expectPhoneLayout(withPanel, 'signature maker open');
    // The whole panel is above the action bar, button included.
    expect(withPanel.controls!.bottom).toBeLessThanOrEqual(withPanel.action!.top + 1);

    await page.getByTestId('signature-mode-type').tap();
    await page.getByLabel('Signature text').fill('Ada Lovelace');
    await page.getByTestId('use-signature').tap();

    // The panel closes and the stamp is on the page, selected, on screen.
    await expect(page.getByTestId('options-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('ws-controls')).toBeHidden();
    const stamp = page.getByTestId('overlay-item');
    await expect(stamp).toBeVisible();
    await expect(stamp).toBeInViewport();
    await expect(page.getByTestId('step-prompt')).toHaveText(
      'Drag your signature into place, or tap the spot where it should go.',
    );
    expectPhoneLayout(await layout(page), 'stamp placed');

    // Corner handles are finger-sized.
    const handle = (await page.getByTestId('overlay-handle-bottom-right').boundingBox())!;
    expect(handle.width).toBeGreaterThanOrEqual(44);
    expect(handle.height).toBeGreaterThanOrEqual(44);

    // Tap where it should go: no drag needed.
    const layer = page.getByTestId('overlay-layer');
    const size = (await layer.boundingBox())!;
    await layer.tap({ position: { x: size.width * 0.5, y: size.height * 0.45 } });
    const placed = await stampViewRect(page);
    expect(placed.x + placed.width / 2).toBeCloseTo(0.5, 1);
    expect(placed.y + placed.height / 2).toBeCloseTo(0.45, 1);

    // "Larger" twice, "Smaller" once: 1.1× overall, with no precise drag.
    await page.getByTestId('stamp-larger').tap();
    await page.getByTestId('stamp-larger').tap();
    await page.getByTestId('stamp-smaller').tap();
    const resized = await stampViewRect(page);
    expect(resized.width / placed.width).toBeCloseTo(1.1, 2);
    expectPhoneLayout(await layout(page), 'after resizing');

    // And the file has it exactly there.
    const bytes = await signAndDownload(page);
    const [image] = await readDrawnImages(bytes, 0);
    expectSameRect(image.rect, resized, 0.004, 'image in the file');
    expectPhoneLayout(await layout(page), 'done');
  });

  test('a finger can drag the stamp', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await page.getByTestId('signature-mode-type').tap();
    await page.getByLabel('Signature text').fill('Ada Lovelace');
    await page.getByTestId('use-signature').tap();
    const stamp = page.getByTestId('overlay-item');
    await expect(stamp).toBeInViewport();
    const before = await stampViewRect(page);

    // Touch pointer events, as a finger sends them: down on the stamp, move, up.
    const box = (await stamp.boundingBox())!;
    const canvas = (await page.getByTestId('page-canvas').boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const [dx, dy] = [30, -50];
    await stamp.evaluate(
      (el, { start, dx, dy }) => {
        const fire = (type: string, x: number, y: number) =>
          el.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 7,
              pointerType: 'touch',
              isPrimary: true,
              button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
              clientX: x,
              clientY: y,
              bubbles: true,
              cancelable: true,
            }),
          );
        fire('pointerdown', start.x, start.y);
        for (let i = 1; i <= 5; i++) fire('pointermove', start.x + (dx * i) / 5, start.y + (dy * i) / 5);
        fire('pointerup', start.x + dx, start.y + dy);
      },
      { start, dx, dy },
    );

    const after = await stampViewRect(page);
    expectSameRect(
      after,
      { ...before, x: before.x + dx / canvas.width, y: before.y + dy / canvas.height },
      0.004,
      'stamp after the drag',
    );
    // The stamp itself does not hand the gesture to the browser's scrolling.
    expect(await stamp.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    // The page around it still does.
    expect(await page.getByTestId('page-viewer').evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none');
  });
});

test.describe('Edit PDF on a phone', () => {
  test('add, resize with taps and the fields, save: the file has the size shown', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf1page);
    await expect(page.getByTestId('options-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('step-prompt')).toHaveText('Choose what to add to this page below.');
    expectPhoneLayout(await layout(page), 'palette open');

    // A tap adds a picture-free shape; the panel closes so the shape is what is seen.
    await page.getByTestId('add-rect').tap();
    await expect(page.getByTestId('options-toggle')).toHaveAttribute('aria-expanded', 'false');
    const item = selectedObject(page);
    await expect(item).toBeInViewport();
    await expect(page.getByTestId('step-prompt')).toHaveText(
      'Drag to move it, pull a corner to resize it, or use Smaller and Larger.',
    );
    const handle = (await page.getByTestId('overlay-handle-bottom-right').boundingBox())!;
    expect(Math.min(handle.width, handle.height)).toBeGreaterThanOrEqual(44);

    // "Larger" twice, "Smaller" once: 1.1× overall, with no drag at all.
    const start = await objectViewRect(item);
    await page.getByTestId('object-larger').tap();
    await page.getByTestId('object-larger').tap();
    await page.getByTestId('object-smaller').tap();
    const resized = await objectViewRect(item);
    expect(resized.width / start.width).toBeCloseTo(1.1, 2);
    expectPhoneLayout(await layout(page), 'after resizing');

    // A second object sized exactly with the fields.
    await page.getByTestId('options-toggle').tap();
    await page.getByTestId('add-text').tap();
    await page.getByTestId('options-toggle').tap();
    await page.getByTestId('font-size').fill('28');
    await page.getByTestId('object-y').fill('150');
    await page.getByTestId('object-y').blur();
    const text = await objectViewRect(selectedObject(page));
    expectPhoneLayout(await layout(page), 'fields used');

    await page.getByTestId('tool-action').tap();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').tap());
    const drawn = await readDrawnObjects(bytes);
    expect(drawn).toHaveLength(2);
    expectSameRect(drawn[0].rect, resized, 0.005, 'rectangle in the file');
    expectSameRect(drawn[1].rect, text, 0.005, 'text in the file');
    expect(drawn[1].fontSize).toBe(28);
    expectPhoneLayout(await layout(page), 'done');
  });
});

test.describe('Compress PDF on a phone', () => {
  test('the quality preview waits for a tap, then compares the page; the document keeps its share', async ({ page }) => {
    await openCompress(page, FIXTURE.pdfPhoto);
    // Battery and memory: nothing is compressed until asked.
    const button = page.getByTestId('preview-quality');
    await expect(button).toBeVisible();
    await expect(page.getByTestId('compress-page')).toHaveAttribute('data-live', 'false');
    await expect(page.getByTestId('compress-preview')).toHaveCount(0);
    expectPhoneLayout(await layout(page), 'before the preview');

    await chooseLevel(page, 'High');
    await page.getByTestId('options-toggle').tap();
    await expect(page.getByTestId('options-toggle')).toHaveAttribute('aria-expanded', 'false');
    await button.tap();
    await settledPreview(page);
    await expect(page.getByTestId('preview-status')).toContainText('Preview of page 1');
    expectPhoneLayout(await layout(page), 'with the preview');

    const action = page.getByTestId('tool-action');
    await action.tap();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('compress-preview')).toHaveAttribute('data-source', 'output', { timeout: 30_000 });
    // Split, side by side and hold all fit; nothing scrolls sideways.
    for (const mode of ['side', 'hold', 'split']) {
      await page.getByTestId(`compare-mode-${mode}`).tap();
      expectPhoneLayout(await layout(page), `compare: ${mode}`);
    }
  });
});

test.describe('PDF to Image on a phone', () => {
  test('taps pick pages, the preview fits and shows the saved size, and the files are the pages tapped', async ({ page }) => {
    await openPdfToImage(page, FIXTURE.pdf5page, 5);
    expectPhoneLayout(await layout(page), 'on entry');
    // Leave out pages 2 and 4 with taps; the field in Options says so.
    await page.getByTestId('page-select-1').tap();
    await page.getByTestId('page-select-3').tap();
    await page.getByTestId('options-toggle').tap();
    await expect(page.getByLabel('Page range to convert')).toHaveValue('1, 3, 5');
    await page.getByRole('button', { name: '72 DPI (screen)' }).tap();
    await page.getByTestId('options-toggle').tap();
    await expect(page.getByTestId('tool-action')).toHaveText('Convert to PNG');

    // The enlarged page fits the screen, and says the pixel size of the file.
    const preview = await openPreview(page, 2, { format: 'png', dpi: 72 });
    const dialog = page.getByTestId('page-preview-dialog');
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await expect(dialog.getByTestId('p2i-preview-size')).toHaveText(`${preview.width} × ${preview.height} px`);
    await page.getByTestId('page-preview-close').tap();
    await expect(dialog).toHaveCount(0);

    await page.getByTestId('tool-action').tap();
    await expect(page.getByTestId('download-button')).toHaveText('Download all (3 images)', { timeout: 45_000 });
    expectPhoneLayout(await layout(page), 'done');
    await page.getByTestId('options-toggle').tap();
    const zip = await expectDownload(page, () => page.getByTestId('download-zip').tap());
    const entries = await readZipEntries(zip.bytes);
    expect(entries.map((e) => e.name)).toEqual(['doc-5page-page-1.png', 'doc-5page-page-3.png', 'doc-5page-page-5.png']);
    expect(pngSize(entries[1].bytes)).toEqual({ width: preview.width, height: preview.height });
  });
});

test.describe('Redact PDF on a phone', () => {
  test('a finger draws a mark, the page shown afterwards is the redacted file, and it removed the text under the mark', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    // Drawing is on: the page layer keeps the finger; the pane around it still scrolls.
    expect(await page.getByTestId('overlay-layer').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    expect(await page.getByTestId('page-viewer').evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none');
    await drawMark(page, { x: 0.06, y: 0.07, width: 0.6, height: 0.06 }, 'touch');
    const shown = await markViewRect(page);
    expect(shown.width).toBeGreaterThan(0.5);
    await expect(page.getByTestId('overlay-remove')).toBeVisible();
    expectPhoneLayout(await layout(page), 'marked');

    await openRedactOptions(page);
    await page.getByTestId('confirm-redaction').tap();
    await page.getByTestId('tool-action').tap();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('page-image')).toHaveAttribute('alt', /^Redacted page 1/);
    expectPhoneLayout(await layout(page), 'done');
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').tap());
    const text = await pageText(bytes, 0);
    expect(text).not.toContain('Test Document');
    expect(text).toContain('Page 1 of 3');
  });

  test('with Draw marks off a finger scrolls the page instead of drawing', async ({ page }) => {
    await openRedact(page, FIXTURE.pdf3page);
    await page.getByTestId('draw-toggle').tap();
    await expect(page.getByTestId('draw-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.getByTestId('overlay-layer').evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none');
    await page.getByTestId('add-mark').tap();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
  });
});
