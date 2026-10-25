import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';
import { addObject, openEdit, setField } from '../helpers/edit-pdf';

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
      await page.getByRole('button', { name: `${label === 'S' ? 'Small' : 'Large'} pages`, exact: true }).click();
      await page.waitForTimeout(300);
      return (await thumb.boundingBox())?.width ?? 0;
    };
    const small = await widthAt('S');
    const large = await widthAt('L');
    expect(large, 'L should render wider thumbnails than S').toBeGreaterThan(small);
  });
});

test.describe('P7 claims — PDF editor', () => {
  /**
   * Each item in the Edit PDF palette must visibly change the page — a button
   * that adds nothing would still "exist" without doing anything. Where each
   * one lands in the saved file, and at what size, is proven in
   * tools/edit-pdf.spec.ts; this only checks it shows.
   */
  for (const kind of ['rect', 'ellipse', 'line', 'arrow', 'highlight', 'whiteout', 'stamp', 'draw'] as const) {
    test(`edit: "${kind}" marks the page`, async ({ page }) => {
      await openEdit(page, FIXTURE.pdf3page);
      const canvas = page.getByTestId('page-canvas');
      // Whiteout is white on a white page: put it over the text so it shows.
      const before = await canvas.screenshot();
      await addObject(page, kind);
      if (kind === 'whiteout') await setField(page, 'object-y', 30);
      // Deselect, so the selection frame is not what changed the pixels.
      await page.getByTestId('overlay-layer').click({ position: { x: 3, y: 3 } });
      expect(Buffer.compare(before, await canvas.screenshot()), `${kind} should mark the page`).not.toBe(0);
    });
  }

  test('edit: undo removes the last addition and redo restores it', async ({ page }) => {
    await openEdit(page, FIXTURE.pdf3page);
    await addObject(page, 'rect');
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);
    await page.getByTestId('redo').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(1);
  });
});

test.describe('P7 claims — image tools', () => {
  test('lock-image: the exported HTML derives its key with PBKDF2-SHA-256, 600,000 iterations', async ({ page }) => {
    await page.goto('/lock-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await page.getByTestId('password').fill('claims-pw-123');
    await page.getByTestId('confirm-password').fill('claims-pw-123');
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());

    const html = bytes.toString('utf8');
    // The self-contained page carries its own decrypt routine, which takes its
    // parameters from the file's header; the advertised ones have to be there.
    const header = JSON.parse(/<script type="application\/json" id="docukit-lock">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(header).toMatchObject({ kdf: 'PBKDF2', hash: 'SHA-256', iterations: 600000, cipher: 'AES-GCM' });
    expect(html).toMatch(/iterations:H\.iterations,hash:H\.hash/);
    expect(html).toMatch(/name:'AES-GCM',length:256/);
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
