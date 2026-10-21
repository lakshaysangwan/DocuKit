import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURE } from '../fixtures/generate';
import { makeMarkerBmp, makeMarkerGif, makeSidewaysJpeg } from '../fixtures/image-fixtures';
import { uploadBuffer } from '../helpers/harness';
import {
  openImages,
  previewPages,
  createAndDownload,
  readOutputPages,
  expectPreviewMatchesFile,
} from '../helpers/image-to-pdf';
import { findMarkerInViewer, markerCentres, readDrawnImages } from '../helpers/sign';

/**
 * Image to PDF: the pages on screen are the pages in the file.
 *
 * The owner's complaint was "I don't know what my image on pdf will look like".
 * So every test here ends by reading the DOWNLOADED file and comparing it with
 * what the preview showed before anything was clicked: page size against
 * MediaBox, draw rectangle against the image's `cm` matrix, page order against
 * the order of the embedded images.
 */

// landscape 1200×800, portrait 900×1200, square 800×800, landscape 1000×700
const MIXED = [FIXTURE.jpg, FIXTURE.jpg2, FIXTURE.png, FIXTURE.webp];
const MM = 72 / 25.4;

const cardNames = (page: Page) =>
  page.getByTestId('file-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-filename')));

/** Render a PDF with pdf.js — in the Sign PDF viewer — and find the marker in its pixels. */
async function markerInRenderedPdf(page: Page, pdf: Buffer) {
  await page.goto('/sign-pdf');
  await uploadBuffer(page, { name: 'output.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  return findMarkerInViewer(page);
}

/** The marker is in the rendered page, each colour in the quadrant it belongs to. */
async function expectMarkerUpright(page: Page, pdf: Buffer) {
  const [drawn] = await readDrawnImages(pdf, 0);
  const expected = markerCentres(drawn.rect);
  const found = await markerInRenderedPdf(page, pdf);
  for (const corner of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const) {
    expect(found[corner], `${corner} colour is in the rendered page`).not.toBeNull();
    expect(Math.abs(found[corner]![0] - expected[corner][0]), `${corner} x`).toBeLessThan(0.02);
    expect(Math.abs(found[corner]![1] - expected[corner][1]), `${corner} y`).toBeLessThan(0.02);
  }
}

test.describe('Image to PDF — the preview is the file', () => {
  const CASES: { name: string; set: (page: Page) => Promise<void>; check?: (pages: Awaited<ReturnType<typeof previewPages>>) => void }[] = [
    {
      name: 'A4, Center, default 10 mm margins — mixed portrait and landscape',
      set: async () => {},
      check: (pages) => {
        // Every page is upright A4 whatever the image; a landscape photo is
        // as wide as the margins allow and sits in the middle.
        for (const p of pages) expect([p.pageW, p.pageH]).toEqual([595.28, 841.89]);
        const landscape = pages[0];
        expect(landscape.draw.x).toBeCloseTo(10 * MM, 1);
        expect(landscape.draw.w).toBeCloseTo(595.28 - 20 * MM, 1);
        expect(landscape.draw.y).toBeGreaterThan(200);
        const portrait = pages[1];
        expect(portrait.draw.w / portrait.draw.h).toBeCloseTo(900 / 1200, 3);
      },
    },
    {
      name: 'Letter, Cover — runs over the margins and is cut at the page edge',
      set: async (page) => {
        await page.getByRole('button', { name: 'Letter' }).click();
        await page.getByRole('button', { name: 'cover', exact: true }).click();
      },
      check: (pages) => {
        const landscape = pages[0];
        expect(landscape.draw.x).toBeLessThan(0);
        expect(landscape.draw.x + landscape.draw.w).toBeGreaterThan(612);
        // Top and bottom still stop at the margins.
        expect(landscape.draw.y).toBeCloseTo(10 * MM, 1);
        expect(landscape.draw.h).toBeCloseTo(792 - 20 * MM, 1);
      },
    },
    {
      name: 'Legal, Stretch — exactly the area inside the margins',
      set: async (page) => {
        await page.getByRole('button', { name: 'Legal' }).click();
        await page.getByRole('button', { name: 'stretch', exact: true }).click();
      },
      check: (pages) => {
        for (const p of pages) {
          expect([p.pageW, p.pageH]).toEqual([612, 1008]);
          expect(p.draw.w).toBeCloseTo(612 - 20 * MM, 1);
          expect(p.draw.h).toBeCloseTo(1008 - 20 * MM, 1);
        }
      },
    },
    {
      name: 'A4, Fit, uneven margins typed in millimetres and inches',
      set: async (page) => {
        await page.getByRole('button', { name: 'fit', exact: true }).click();
        await page.getByLabel(/top margin/i).fill('30');
        await page.getByLabel(/right margin/i).fill('0');
        await page.getByTestId('i2p-unit-in').click();
        await page.getByLabel(/left margin/i).fill('1.5');
      },
      check: (pages) => {
        const landscape = pages[0];
        expect(landscape.draw.x).toBeCloseTo(108, 1);
        expect(landscape.draw.w).toBeCloseTo(595.28 - 108, 1);
      },
    },
    {
      name: 'Fit Image — each page is its image, with the margins still applied',
      set: async (page) => {
        await page.getByRole('button', { name: 'Fit Image' }).click();
      },
      check: (pages) => {
        expect(pages.map((p) => [p.pageW, p.pageH])).toEqual([[1200, 800], [900, 1200], [800, 800], [1000, 700]]);
        // The margin fields are hidden, but the 10 mm margins are in the page.
        expect(pages[0].draw.y).toBeCloseTo(10 * MM, 1);
        expect(pages[0].draw.h).toBeCloseTo(800 - 20 * MM, 1);
        expect(pages[0].draw.w).toBeLessThan(1200 - 20 * MM);
      },
    },
    {
      name: 'Fit Image chosen after Cover — the hidden placement still applies',
      set: async (page) => {
        await page.getByRole('button', { name: 'cover', exact: true }).click();
        await page.getByRole('button', { name: 'Fit Image' }).click();
      },
    },
  ];

  for (const { name, set, check } of CASES) {
    test(name, async ({ page }) => {
      await openImages(page, MIXED);
      await set(page);

      const shown = await previewPages(page);
      expect(shown.map((p) => p.filename)).toEqual(['photo.jpg', 'photo-2.jpg', 'graphic.png', 'image.webp']);
      expect(shown.map((p) => p.label)).toEqual(['Page 1 of 4', 'Page 2 of 4', 'Page 3 of 4', 'Page 4 of 4']);
      check?.(shown);

      const written = await readOutputPages(await createAndDownload(page));
      expectPreviewMatchesFile(shown, written);
      // Same images, same order.
      expect(written.map((p) => [p.image.width, p.image.height])).toEqual([[1200, 800], [900, 1200], [800, 800], [1000, 700]]);

      // And the pages still on show after the PDF is made are the same pages.
      expectPreviewMatchesFile(await previewPages(page), written);
    });
  }
});

test.describe('Image to PDF — the preview follows the options', () => {
  test('typing a margin moves the image before anything is clicked', async ({ page }) => {
    await openImages(page, FIXTURE.jpg);
    const before = (await previewPages(page))[0];
    expect(before.draw.x).toBeCloseTo(10 * MM, 1);

    // Key by key, as a person types: the preview is right after every key.
    const left = page.getByLabel(/left margin/i);
    await left.press('ControlOrMeta+a');
    await left.press('4');
    await expect.poll(async () => (await previewPages(page))[0].draw.x).toBeCloseTo(4 * MM, 1);
    await left.press('0');
    await expect.poll(async () => (await previewPages(page))[0].draw.x).toBeCloseTo(40 * MM, 1);

    const after = (await previewPages(page))[0];
    expect(after.imageBox.x).toBeCloseTo((40 * MM) / 595.28, 2);
    expect(after.imageBox.x).toBeGreaterThan(before.imageBox.x + 0.1);
    // The dashed guide moved with it.
    const guide = await page.getByTestId('output-page-margins').first().evaluate((el) => {
      const pageBox = el.parentElement!.getBoundingClientRect();
      return (el.getBoundingClientRect().left - pageBox.left) / pageBox.width;
    });
    expect(guide).toBeCloseTo((40 * MM) / 595.28, 2);

    // Nothing was run to get there.
    await expect(page.getByTestId('action-bar')).toHaveAttribute('data-phase', 'ready');
    await expect(page.getByTestId('download-button')).toHaveCount(0);

    // And it is what the file gets.
    expectPreviewMatchesFile([after], await readOutputPages(await createAndDownload(page)));
  });

  test('the page size changes the shape of the page on screen', async ({ page }) => {
    await openImages(page, FIXTURE.jpg);
    const aspect = async () => (await previewPages(page))[0].boxAspect;
    const caption = page.getByTestId('page-grid-caption');

    expect(await aspect()).toBeCloseTo(595.28 / 841.89, 2);
    await expect(caption).toHaveText('A4 · 210 × 297 mm · portrait');

    await page.getByRole('button', { name: 'Letter' }).click();
    expect(await aspect()).toBeCloseTo(612 / 792, 2);
    await expect(caption).toHaveText('Letter · 216 × 279 mm · portrait');

    await page.getByRole('button', { name: 'Legal' }).click();
    expect(await aspect()).toBeCloseTo(612 / 1008, 2);
    await expect(caption).toHaveText('Legal · 216 × 356 mm · portrait');

    // "Fit Image": the page takes the landscape photo's own shape.
    await page.getByRole('button', { name: 'Fit Image' }).click();
    expect(await aspect()).toBeCloseTo(1200 / 800, 2);
    await expect(caption).toHaveText('Fit Image · each page is the size of its image');
    await expect(page.getByTestId('file-card')).toContainText('423 × 282 mm');
  });

  test('S, M and L change how many pages fit across, not the pages', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openImages(page, MIXED);
    const width = async () => (await page.getByTestId('file-card').first().boundingBox())!.width;
    // Medium to start with at this width: all four pages on screen, none cut off.
    await expect(page.getByTestId('grid-size-m')).toHaveAttribute('aria-pressed', 'true');
    const stage = (await page.getByTestId('ws-stage').boundingBox())!;
    for (const card of await page.getByTestId('file-card').all()) {
      const box = (await card.boundingBox())!;
      expect(box.y + box.height, 'the whole card is inside the document pane').toBeLessThanOrEqual(stage.y + stage.height);
    }
    const medium = await width();
    await page.getByTestId('grid-size-l').click();
    const large = await width();
    await page.getByTestId('grid-size-s').click();
    const small = await width();
    expect(medium).toBeLessThan(large);
    expect(small).toBeLessThan(medium);
    await expect(page.getByTestId('grid-size-s')).toHaveAttribute('aria-pressed', 'true');
    // The page keeps its proportions at every size.
    expect((await previewPages(page))[0].boxAspect).toBeCloseTo(595.28 / 841.89, 1);
  });
});

test.describe('Image to PDF — order and removal', () => {
  const THREE = [FIXTURE.jpg, FIXTURE.jpg2, FIXTURE.png];
  const SIZE = { 'photo.jpg': [1200, 800], 'photo-2.jpg': [900, 1200], 'graphic.png': [800, 800] } as const;

  /** The file's pages, as the image each one carries. */
  const fileOrder = async (pdf: Buffer) => (await readOutputPages(pdf)).map((p) => [p.image.width, p.image.height]);

  test('dragging a page moves it in the preview and in the file', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openImages(page, THREE);
    expect(await cardNames(page)).toEqual(['photo.jpg', 'photo-2.jpg', 'graphic.png']);

    // Take the first page by the picture itself and drop it on the third.
    const from = (await page.getByTestId('page-thumb').nth(0).boundingBox())!;
    const to = (await page.getByTestId('page-thumb').nth(2).boundingBox())!;
    // Moved at a hand's pace: the drop target is worked out a render after each
    // move, so moves fired with no gap can be dropped on a stale target.
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 16; step++) {
      await page.waitForTimeout(20);
      await page.mouse.move(start.x + ((end.x - start.x) * step) / 16, start.y + ((end.y - start.y) * step) / 16);
    }
    await expect(page.getByText(/photo\.jpg moved to position 3 of 3/)).toBeAttached();
    await page.mouse.up();
    // dnd-kit swallows every click for 50 ms after a drag ends, so that letting
    // go is not also a click; a test clicking Create PDF sooner loses the click.
    await page.waitForTimeout(100);

    await expect.poll(() => cardNames(page)).toEqual(['photo-2.jpg', 'graphic.png', 'photo.jpg']);
    // A drag is not a click: the page was not opened large.
    await expect(page.getByTestId('page-preview-dialog')).toHaveCount(0);
    expect((await previewPages(page)).map((p) => p.label)).toEqual(['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);

    const shown = await previewPages(page);
    const pdf = await createAndDownload(page);
    expect(await fileOrder(pdf)).toEqual([SIZE['photo-2.jpg'], SIZE['graphic.png'], SIZE['photo.jpg']]);
    expectPreviewMatchesFile(shown, await readOutputPages(pdf));
  });

  test('the keyboard handle moves a page in the preview and in the file', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openImages(page, THREE);

    await page.getByRole('button', { name: 'Reorder graphic.png' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByText(/graphic\.png moved to position 3 of 3/)).toBeAttached();
    // The sensor starts taking arrow keys a timer tick after the pick-up.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByText(/graphic\.png moved to position 2 of 3/)).toBeAttached();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByText(/graphic\.png moved to position 1 of 3/)).toBeAttached();
    await page.keyboard.press('Space');
    await expect(page.getByText(/graphic\.png dropped at position 1 of 3/)).toBeAttached();

    await expect.poll(() => cardNames(page)).toEqual(['graphic.png', 'photo.jpg', 'photo-2.jpg']);
    expect(await fileOrder(await createAndDownload(page))).toEqual([
      SIZE['graphic.png'],
      SIZE['photo.jpg'],
      SIZE['photo-2.jpg'],
    ]);
  });

  test('removing a page drops it from the preview, the count and the file', async ({ page }) => {
    await openImages(page, THREE);
    await expect(page.getByTestId('tool-action')).toHaveText('Create PDF (3 pages)');
    await expect(page.getByTestId('file-info')).toContainText('3 images');

    await page.getByRole('button', { name: 'Remove photo-2.jpg' }).click();
    expect(await cardNames(page)).toEqual(['photo.jpg', 'graphic.png']);
    await expect(page.getByTestId('tool-action')).toHaveText('Create PDF (2 pages)');
    await expect(page.getByTestId('file-info')).toContainText('2 images');
    expect((await previewPages(page)).map((p) => p.label)).toEqual(['Page 1 of 2', 'Page 2 of 2']);

    expect(await fileOrder(await createAndDownload(page))).toEqual([SIZE['photo.jpg'], SIZE['graphic.png']]);

    // Removing the last ones leaves the workspace for the dropzone.
    await page.getByTestId('remove-file').click();
    await expect(page.getByTestId('workspace')).toHaveCount(0);
    await expect(page.getByTestId('dropzone')).toHaveAttribute('data-compact', 'false');
  });

  test('images can be added from the options, and land at the end', async ({ page }) => {
    await openImages(page, FIXTURE.jpg);
    await expect(page.getByTestId('tool-action')).toHaveText('Create PDF (1 page)');
    const dropzone = page.getByTestId('ws-controls').getByTestId('dropzone');
    await expect(dropzone).toContainText('Add images');
    await page.getByTestId('ws-controls').locator('input[type="file"]').setInputFiles([FIXTURE.png, FIXTURE.jpg2]);
    await expect(page.getByTestId('output-page')).toHaveCount(3);
    expect(await cardNames(page)).toEqual(['photo.jpg', 'graphic.png', 'photo-2.jpg']);
    await expect(page.getByTestId('tool-action')).toHaveText('Create PDF (3 pages)');
  });
});

test.describe('Image to PDF — images a PDF cannot hold as they are', () => {
  test('a photo stored sideways with an EXIF orientation comes out upright', async ({ page }) => {
    await page.goto('/image-to-pdf');
    const sideways = await makeSidewaysJpeg(page);
    await openImages(page, { name: 'phone-photo.jpg', mimeType: 'image/jpeg', buffer: sideways });
    await page.getByRole('button', { name: 'Fit Image' }).click();

    // The browser shows it 600 × 400, upright — and so does the preview.
    const [shown] = await previewPages(page);
    expect([shown.pageW, shown.pageH]).toEqual([600, 400]);
    await expect(page.getByTestId('file-card')).toContainText('turned upright');

    const pdf = await createAndDownload(page);
    const [written] = await readOutputPages(pdf);
    expectPreviewMatchesFile([shown], [written]);
    // The embedded picture itself is upright, not a sideways one with a note.
    expect([written.image.width, written.image.height]).toEqual([600, 400]);
    expect(written.image.filter).toContain('DCTDecode');

    // Rendered: every colour of the marker is in its own corner.
    await expectMarkerUpright(page, pdf);
  });

  test('an upright JPEG is embedded untouched, byte for byte', async ({ page }) => {
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(FIXTURE.jpg);
    await openImages(page, FIXTURE.jpg);
    const pdf = await createAndDownload(page);
    expect(pdf.includes(original), 'the original JPEG bytes are inside the PDF').toBe(true);
    await expect(page.getByTestId('file-card')).not.toContainText('saved as');
  });

  const CONVERTED: { name: string; file: () => Parameters<typeof openImages>[1]; size: [number, number]; marker: boolean }[] = [
    { name: 'WebP', file: () => FIXTURE.webp, size: [1000, 700], marker: false },
    { name: 'BMP', file: () => ({ name: 'scan.bmp', mimeType: 'image/bmp', buffer: makeMarkerBmp() }), size: [240, 160], marker: true },
    { name: 'GIF', file: () => ({ name: 'drawing.gif', mimeType: 'image/gif', buffer: makeMarkerGif() }), size: [240, 160], marker: true },
    { name: 'HEIC', file: () => FIXTURE.heic, size: [600, 400], marker: false },
  ];

  for (const { name, file, size, marker } of CONVERTED) {
    test(`${name} becomes a JPEG page`, async ({ page }) => {
      // HEIC is decoded by a WASM library where the browser cannot do it itself.
      test.slow(name === 'HEIC');
      await openImages(page, file());
      await expect(page.getByTestId('file-card')).toContainText('saved as JPEG');
      await page.getByRole('button', { name: 'Fit Image' }).click();

      const [shown] = await previewPages(page);
      expect([shown.pageW, shown.pageH]).toEqual(size);

      const pdf = await createAndDownload(page);
      const [written] = await readOutputPages(pdf);
      expectPreviewMatchesFile([shown], [written]);
      expect([written.image.width, written.image.height]).toEqual(size);
      expect(written.image.filter).toContain('DCTDecode');
      expect(written.image.hasSoftMask).toBe(false);

      // The pixels are the picture, the right way up.
      if (marker) await expectMarkerUpright(page, pdf);
    });
  }

  test('an image with transparency becomes a PNG page and keeps its transparency', async ({ page }) => {
    const gif = makeMarkerGif({ transparentQuadrant: 'bottomRight' });
    await openImages(page, { name: 'logo.gif', mimeType: 'image/gif', buffer: gif });
    await expect(page.getByTestId('file-card')).toContainText('saved as PNG');

    const pdf = await createAndDownload(page);
    const [written] = await readOutputPages(pdf);
    expect([written.image.width, written.image.height]).toEqual([240, 160]);
    expect(written.image.filter).toContain('FlateDecode');
    expect(written.image.hasSoftMask, 'the image carries an alpha mask').toBe(true);

    // Rendered on the white page: three quadrants keep their colour, the
    // see-through one shows the page.
    const found = await markerInRenderedPdf(page, pdf);
    expect(found.topLeft).not.toBeNull();
    expect(found.topRight).not.toBeNull();
    expect(found.bottomLeft).not.toBeNull();
    expect(found.bottomRight, 'the transparent quadrant is not painted').toBeNull();
  });

  test('a file that is not really an image says so and holds the action back', async ({ page }) => {
    await openImages(page, FIXTURE.jpg);
    await page
      .getByTestId('ws-controls')
      .locator('input[type="file"]')
      .setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is not a picture') });

    await expect(page.getByTestId('page-unreadable')).toHaveText('This image could not be read.');
    await expect(page.getByTestId('step-prompt')).toHaveText('1 image could not be read. Remove it to continue.');
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('Remove the image that could not be read');

    await page.getByRole('button', { name: 'Remove broken.jpg' }).click();
    await expect(page.getByTestId('tool-action')).toBeEnabled();
    await expect(page.getByTestId('tool-action')).toHaveText('Create PDF (1 page)');
  });

  test('margins that leave no room hold the action back with the reason', async ({ page }) => {
    await openImages(page, FIXTURE.jpg);
    await page.getByLabel(/left margin/i).fill('150');
    await page.getByLabel(/right margin/i).fill('150');
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText('The margins leave no room for the image');
    await page.getByLabel(/right margin/i).fill('10');
    await expect(page.getByTestId('tool-action')).toBeEnabled();
  });
});

test.describe('Image to PDF — viewing a page large', () => {
  test('opens from the button or the page, pages through, and gives focus back', async ({ page }) => {
    await openImages(page, [FIXTURE.jpg, FIXTURE.jpg2]);
    const dialog = page.getByTestId('page-preview-dialog');
    const first = page.getByRole('button', { name: 'View page 1 larger: photo.jpg' });
    const second = page.getByRole('button', { name: 'View page 2 larger: photo-2.jpg' });

    // From the keyboard.
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 1 of 2 · photo.jpg');
    // The same page, with the same numbers, only larger.
    const card = page.getByTestId('file-card').first().getByTestId('output-page');
    const large = dialog.getByTestId('output-page');
    expect(await large.getAttribute('data-draw')).toBe(await card.getAttribute('data-draw'));
    const box = (await large.boundingBox())!;
    expect(box.width).toBeGreaterThan((await card.boundingBox())!.width * 1.15);
    expect(box.height, 'the page takes most of the screen').toBeGreaterThan(page.viewportSize()!.height * 0.8);
    expect(box.width / box.height).toBeCloseTo(595.28 / 841.89, 2);

    // Focus is inside the dialog, and the dialog has no serious accessibility faults.
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(
      axe.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes[0]?.target}`),
      'axe with the page open large',
    ).toEqual([]);

    // Previous is unavailable on the first page; Next goes on.
    await expect(page.getByTestId('page-preview-prev')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('page-preview-next').click();
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 2 of 2 · photo-2.jpg');
    await expect(page.getByTestId('page-preview-next')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 1 of 2 · photo.jpg');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 2 of 2 · photo-2.jpg');

    // Esc closes; focus goes to the page that was on show.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(second).toBeFocused();

    // Clicking the page itself opens it too; a click outside closes it.
    await page.getByTestId('page-thumb').first().click();
    await expect(page.getByTestId('page-preview-title')).toHaveText('Page 1 of 2 · photo.jpg');
    await page.mouse.click(4, 4);
    await expect(dialog).toHaveCount(0);
    await expect(first).toBeFocused();

    // And the close button.
    await second.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('page-preview-close').click();
    await expect(dialog).toHaveCount(0);
    await expect(second).toBeFocused();
  });
});

test.describe('Image to PDF — one action, and a result that never goes stale', () => {
  const make = async (page: Page) => {
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  };
  const expectReady = async (page: Page) => {
    await expect(page.getByTestId('tool-action')).toBeVisible();
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('action-bar')).toHaveAttribute('data-phase', 'ready');
  };

  test('the result says what was made, and Make changes brings the options back', async ({ page }) => {
    await openImages(page, [FIXTURE.jpg, FIXTURE.png]);
    await expect(page.getByTestId('step-prompt')).toContainText('These are the 2 pages your PDF will have');
    await make(page);

    await expect(page.getByTestId('step-prompt')).toHaveText('Your PDF is ready. Download it, or make changes.');
    await expect(page.getByTestId('download-button')).toHaveText(/Download PDF/);
    await expect(page.getByTestId('result-summary')).toHaveText(/^images\.pdf · [\d.]+ [KM]B · 2 pages$/);
    await expect(page.getByTestId('result-panel')).toContainText('PDF created!');
    // The options are replaced by the result; the pages stay on show.
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await expect(page.getByTestId('output-page')).toHaveCount(2);
    // The finished pages are shown clean, without the margin guides.
    await expect(page.getByTestId('output-page-margins')).toHaveCount(0);

    await page.getByTestId('edit-again').click();
    await expectReady(page);
    await expect(page.getByLabel(/top margin/i)).toBeVisible();
    await expect(page.getByTestId('output-page-margins')).toHaveCount(2);
  });

  test('changing anything after the PDF is made takes the download away', async ({ page }) => {
    await openImages(page, [FIXTURE.jpg, FIXTURE.png, FIXTURE.jpg2]);

    // An option.
    await make(page);
    await page.getByTestId('edit-again').click();
    await page.getByRole('button', { name: 'Letter' }).click();
    await expectReady(page);

    // The order.
    await make(page);
    await page.getByRole('button', { name: 'Reorder photo.jpg' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByText(/photo\.jpg moved to position 1 of 3/)).toBeAttached();
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(/photo\.jpg moved to position 2 of 3/)).toBeAttached();
    await page.keyboard.press('Space');
    await expectReady(page);

    // Removing a page.
    await make(page);
    await page.getByRole('button', { name: 'Remove graphic.png' }).click();
    await expectReady(page);

    // Adding one.
    await make(page);
    await page.locator('input[type="file"]').first().setInputFiles(FIXTURE.png);
    await expectReady(page);
    await expect(page.getByTestId('tool-action')).toHaveText('Create PDF (3 pages)');

    // And the file made now is the document as it stands: Letter, in the new order.
    const shown = await previewPages(page);
    expect(shown.map((p) => p.filename)).toEqual(['photo.jpg', 'photo-2.jpg', 'graphic.png']);
    const written = await readOutputPages(await createAndDownload(page));
    expectPreviewMatchesFile(shown, written);
    expect(written.map((p) => [p.pageW, p.pageH])).toEqual([[612, 792], [612, 792], [612, 792]]);
  });
});
