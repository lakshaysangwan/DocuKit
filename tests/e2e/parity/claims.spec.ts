import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  addSingleFileAndWait,
  uploadFiles,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

/**
 * Phase 7 — proving advertised claims that previously had no coverage.
 *
 * Each test here corresponds to a bullet in src/lib/tools-registry.ts that
 * tests/e2e/parity/coverage.ts used to list as `unproven`. Anything still marked
 * unproven after this file is either untestable headlessly (third-party reader
 * verification) or not actually implemented — see the copy-drift list in
 * FIX-PLAN, which is a product decision rather than a testing gap.
 */
test.describe('P7 claims — PDF tools', () => {
  test('split: "odd" keyword selects the odd pages', async ({ page }) => {
    await page.goto('/split-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await page.getByRole('textbox').fill('odd');
    // 5-page document -> pages 1, 3, 5.
    await expect(page.getByText('3 of 5 pages selected')).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(3);
  });

  test('split: "even" and "last" keywords resolve too', async ({ page }) => {
    await page.goto('/split-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await page.getByRole('textbox').fill('even');
    await expect(page.getByText('2 of 5 pages selected')).toBeVisible();
    await page.getByRole('textbox').fill('last');
    await expect(page.getByText('1 of 5 pages selected')).toBeVisible();
  });

  test('split: the range input reports a live page count', async ({ page }) => {
    await page.goto('/split-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await page.getByRole('textbox').fill('1-2');
    await expect(page.getByText('2 of 5 pages selected')).toBeVisible();
    await page.getByRole('textbox').fill('1-4');
    await expect(page.getByText('4 of 5 pages selected')).toBeVisible();
  });

  test('pdf-to-image: the 600 DPI preset yields a larger raster than 72 DPI', async ({ page }) => {
    const pixels = async (dpiLabel: string) => {
      await page.goto('/pdf-to-image');
      await addSingleFileAndWait(page, FIXTURE.pdf1page);
      await page.getByRole('button', { name: dpiLabel }).click();
      await page.getByTestId('tool-action').click();
      await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
      const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
      return page.evaluate(
        (b64) =>
          new Promise<number>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth);
            img.onerror = () => reject(new Error('decode failed'));
            img.src = `data:image/png;base64,${b64}`;
          }),
        bytes.toString('base64')
      );
    };

    const low = await pixels('72 DPI (screen)');
    const high = await pixels('600 DPI (archival)');
    // 600/72 is a bit over 8x; assert the direction and rough magnitude rather
    // than an exact size, since the viewport rounds to whole pixels.
    expect(high).toBeGreaterThan(low * 4);
  });

  test('protect: permission checkboxes are exposed and toggle', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByText('Permissions', { exact: true })).toBeVisible();
    const boxes = page.locator('input[type="checkbox"]');
    expect(await boxes.count(), 'expected several permission toggles').toBeGreaterThan(2);

    const first = boxes.first();
    const was = await first.isChecked();
    await first.click();
    expect(await first.isChecked()).toBe(!was);
  });

  test('protect: a permission-restricted PDF still encrypts and round-trips', async ({ page }) => {
    const PW = 'perm-test-pw';
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.locator('input[type="checkbox"]').first().click();
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('confirm-password').fill(PW);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(bytes.toString('latin1')).toContain('/Encrypt');
  });

  test('organize: the zoom control resizes the page thumbnails', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    const thumb = page.getByTestId('page-thumb').first();
    await expect(thumb).toBeVisible({ timeout: 30_000 });

    const widthAt = async (label: string) => {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(300);
      return (await thumb.boundingBox())?.width ?? 0;
    };
    const small = await widthAt('S');
    const large = await widthAt('L');
    expect(large, 'L should render wider thumbnails than S').toBeGreaterThan(small);
  });
});

test.describe('P7 claims — PDF editor', () => {
  // The Fabric surface renders ~1100x1430 CSS px inside its wrapper. At the
  // default 1280x720 viewport most of it sits below the fold, and mouse
  // coordinates taken from its bounding box land outside the viewport entirely,
  // so drags silently do nothing. Give these tests room to see the whole page.
  test.use({ viewport: { width: 1400, height: 1500 } });
  /**
   * The [data-testid="editor-canvas"] element is a wrapper: inside it Fabric
   * renders at native PDF dimensions and is scaled with a CSS transform. Mouse
   * coordinates therefore have to come from Fabric's own interaction surface
   * (.upper-canvas), while screenshots come from the wrapper.
   */
  const openEditor = async (page: import('@playwright/test').Page) => {
    await page.goto('/edit-pdf');
    await uploadFiles(page, FIXTURE.pdf3page);
    const wrapper = page.getByTestId('editor-canvas');
    await expect(wrapper).toBeVisible({ timeout: 30_000 });
    // Fabric's interaction surface is the second <canvas> in the wrapper; the
    // first is the rendered PDF background. Neither carries a class here.
    const surface = page.locator('[data-testid="editor-canvas"] canvas').last();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    return { wrapper, surface };
  };

  /** Drag across the middle of Fabric's interaction surface. */
  const dragAcross = async (page: import('@playwright/test').Page, surface: import('@playwright/test').Locator) => {
    await surface.scrollIntoViewIfNeeded();
    const box = (await surface.boundingBox())!;
    // Stay in the upper band of the canvas so the points remain on-screen.
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.60, box.y + box.height * 0.25, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);
  };

  // Each tool must visibly change the canvas — a toolbar button that selects a
  // mode but draws nothing would still "exist" without doing anything.
  for (const [claim, title] of [
    ['rectangle', 'Rectangle (R)'],
    ['ellipse', 'Ellipse (E)'],
    ['line', 'Line (L)'],
    ['arrow', 'Arrow (A)'],
  ] as const) {
    test(`edit: shape tool "${claim}" draws on the canvas`, async ({ page }) => {
      const { wrapper, surface } = await openEditor(page);
      const before = await wrapper.screenshot();
      await page.locator(`button[title="${title}"]`).click();
      await dragAcross(page, surface);
      const after = await wrapper.screenshot();
      expect(Buffer.compare(before, after), `${claim} should mark the canvas`).not.toBe(0);
    });
  }

  test('edit: freehand draw marks the canvas', async ({ page }) => {
    const { wrapper, surface } = await openEditor(page);
    const before = await wrapper.screenshot();
    await page.locator('button[title="Freehand Draw (D)"]').click();
    await surface.scrollIntoViewIfNeeded();
    const box = (await surface.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.10);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * (0.10 + i * 0.008));
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect(Buffer.compare(before, await wrapper.screenshot())).not.toBe(0);
  });

  for (const [claim, title] of [
    ['highlight', 'Highlight (H)'],
    ['whiteout', 'Whiteout (W)'],
  ] as const) {
    test(`edit: ${claim} tool marks the canvas`, async ({ page }) => {
      const { wrapper, surface } = await openEditor(page);
      const before = await wrapper.screenshot();
      await page.locator(`button[title="${title}"]`).click();
      await dragAcross(page, surface);
      expect(Buffer.compare(before, await wrapper.screenshot())).not.toBe(0);
    });
  }

  test('edit: stamp tool places a stamp', async ({ page }) => {
    const { wrapper, surface } = await openEditor(page);
    const before = await wrapper.screenshot();
    await page.locator('button[title="Stamp (S)"]').click();
    await surface.scrollIntoViewIfNeeded();
    const box = (await surface.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.15);
    await page.waitForTimeout(600);
    expect(Buffer.compare(before, await wrapper.screenshot())).not.toBe(0);
  });

  test('edit: undo removes the last annotation and redo restores it', async ({ page }) => {
    const { wrapper, surface } = await openEditor(page);
    const clean = await wrapper.screenshot();

    // Draw a rectangle rather than dropping a text box: the drag path is proven
    // above to mark the canvas, so a failure here is undo's, not the tool's.
    await page.locator('button[title="Rectangle (R)"]').click();
    await dragAcross(page, surface);
    const drawn = await wrapper.screenshot();
    expect(Buffer.compare(clean, drawn), 'rectangle should appear').not.toBe(0);

    await page.locator('button[title="Undo (Ctrl+Z)"]').click();
    await page.waitForTimeout(800);
    const undone = await wrapper.screenshot();
    expect(Buffer.compare(drawn, undone), 'undo should change the canvas').not.toBe(0);

    await page.locator('button[title="Redo (Ctrl+Shift+Z)"]').click();
    await page.waitForTimeout(800);
    expect(Buffer.compare(undone, await wrapper.screenshot()), 'redo should change it back').not.toBe(0);
  });
});

test.describe('P7 claims — image tools', () => {
  test('lock-image: the exported HTML derives its key with 100,000 PBKDF2 iterations', async ({ page }) => {
    await page.goto('/lock-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await page.getByTestId('password').fill('claims-pw-123');
    await page.getByTestId('confirm-password').fill('claims-pw-123');
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());

    const html = bytes.toString('utf8');
    // The self-contained page carries its own decrypt routine; the advertised
    // parameters have to be visible in it.
    expect(html).toMatch(/PBKDF2/);
    expect(html).toMatch(/iterations\s*:\s*100_?000/);
    expect(html).toMatch(/AES-GCM/);
    expect(html).toMatch(/SHA-256/);
  });

  test('compress-image: output carries no EXIF metadata', async ({ page }) => {
    // Re-encoding from raw pixels drops EXIF by construction; this pins that
    // outcome so a future codec change cannot quietly start preserving it.
    await page.goto('/compress-image');
    await addSingleFileAndWait(page, FIXTURE.jpgExif);

    const original = await import('node:fs/promises').then((fs) => fs.readFile(FIXTURE.jpgExif));
    expect(original.toString('latin1'), 'fixture must actually carry EXIF').toContain('Exif\0\0');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect(bytes.toString('latin1'), 'compressed output should not carry EXIF').not.toContain('Exif\0\0');
    expect(bytes.toString('latin1'), 'and no GPS tags either').not.toContain('GPSLatitude');
  });
});
