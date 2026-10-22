import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  addFilesAndWait,
  addSingleFileAndWait,
  uploadFiles,
  expectDownload,
  expectDownloads,
  assertImage,
  assertPdf,
  extractPdfText,
  countPdfPagesStrict,
  findPdfContentStreamIndex,
  readPdfContentStreams,
} from '../helpers/harness';
import { openSign, addTypedSignature } from '../helpers/sign';

/**
 * The source-check closures.
 *
 * A sweep read all 24 remaining `unproven` bullets against the code asking only
 * "is this false?" and found twelve that were. Five were product decisions and
 * their copy was trimmed; the seven below were built, and each test here pins
 * one of them so the bullet has something behind it.
 *
 * These deliberately assert on output structure rather than on the control
 * merely existing — the sweep's central finding was that several tools rendered
 * a control (or carried an option in the type) that nothing downstream read.
 */

test.describe('Source-check closures — watermark', () => {
  test('applies to a specific page range and leaves the others alone', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    await page.getByTestId('wm-apply-range').click();
    await page.getByTestId('wm-page-range').fill('2, 4');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(5);

    // Pages 2 and 4 (indices 1 and 3) carry it; the rest must not.
    const expected = [false, true, false, true, false];
    for (let i = 0; i < expected.length; i++) {
      const text = await extractPdfText(bytes, i);
      expect(
        text.includes('CONFIDENTIAL'),
        `page ${i + 1} ${expected[i] ? 'should' : 'should not'} be watermarked`,
      ).toBe(expected[i]);
    }
  });

  test('refuses to run when the range selects nothing', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    await page.getByTestId('wm-apply-range').click();
    await page.getByTestId('wm-page-range').fill('99');

    // A silent no-op was the failure mode worth guarding against here. In the
    // workspace the action cannot be pressed, and says why next to it.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText(/Enter which pages to watermark/i);
    await expect(page.getByTestId('download-button')).toHaveCount(0);
  });

  test('layer control really changes z-order, not just the options object', async ({ page }) => {
    const run = async (layer: 'front' | 'behind') => {
      await page.goto('/watermark-pdf');
      await addSingleFileAndWait(page, FIXTURE.pdf3page);
      await page.getByTestId(`wm-layer-${layer}`).click();
      await page.getByTestId('tool-action').click();
      const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
      assertPdf(bytes);
      return findPdfContentStreamIndex(bytes, 'CONFIDENTIAL');
    };

    const front = await run('front');
    const behind = await run('behind');

    // Both must actually contain the watermark somewhere.
    expect(front.index).toBeGreaterThanOrEqual(0);
    expect(behind.index).toBeGreaterThanOrEqual(0);

    // /Contents streams paint in array order: behind = first, on top = last.
    // The rendered pixels cannot tell these apart on a page with no background,
    // which is why the assertion is structural.
    expect(behind.index).toBe(0);
    expect(front.index).toBe(front.total - 1);
    expect(behind.index).toBeLessThan(front.index);
  });
});

test.describe('Source-check closures — page numbers', () => {
  test('the font selector changes the font embedded in the output', async ({ page }) => {
    const run = async (value: string) => {
      await page.goto('/add-page-numbers');
      await uploadFiles(page, FIXTURE.pdf3page);
      await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('pn-font').selectOption(value);
      await page.getByTestId('tool-action').click();
      const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
      assertPdf(bytes);
      return bytes.toString('latin1');
    };

    // The worker used to embed Helvetica no matter what `options.font` said.
    const courier = await run('Courier');
    expect(courier).toContain('/Courier');

    const times = await run('Times-Roman');
    expect(times).toContain('/Times-Roman');
    expect(times).not.toContain('/Courier');
  });
});

test.describe('Source-check closures — image to PDF', () => {
  test('margin units convert instead of reusing the number', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg], 1);

    const topMargin = page.getByLabel(/top margin/i);
    await topMargin.fill('10'); // 10 mm, the default unit
    await page.getByTestId('i2p-unit-in').click();

    // 10 mm is 0.39 in — switching units must preserve the physical size, not
    // silently reinterpret "10" as ten inches.
    await expect(topMargin).toHaveValue('0.39');

    await page.getByTestId('i2p-unit-pt').click();
    await expect(topMargin).toHaveValue('28.35');

    // And back again without drift: the margin is held in points, so a round
    // trip through other units must not hand back a twice-rounded 9.91 mm.
    await page.getByTestId('i2p-unit-mm').click();
    await expect(topMargin).toHaveValue('10');
  });

  test('a margin typed in inches lands in the PDF as 72 points per inch', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg], 1);

    await page.getByTestId('i2p-unit-in').click();
    // Typed over the old value key by key, decimal point included, the way a
    // person enters it — a fractional inch has to survive the keystrokes.
    const left = page.getByLabel(/left margin/i);
    await left.press('ControlOrMeta+a');
    await left.pressSequentially('1.5');
    await expect(left).toHaveValue('1.5');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(1);

    // The fixture is a 3:2 landscape photo on a landscape A4 page, so the image
    // is as wide as the margins allow and its left edge sits exactly on the left margin.
    // pdf-lib paints an image as translate(x, y), rotate, scale(w, h), skew, Do —
    // so the translate and scale just ahead of the "Do" are its box in points.
    const content = (await readPdfContentStreams(bytes)).join('\n');
    const draw = content.match(
      /1 0 0 1 ([\d.]+) ([\d.]+) cm\s+1 0 0 1 0 0 cm\s+([\d.]+) 0 0 ([\d.]+) 0 0 cm\s+1 0 0 1 0 0 cm\s+\/\S+ Do/,
    );
    expect(draw, 'the image draw should be readable from the content stream').not.toBeNull();
    const [, x, , width] = draw!.map(Number);
    expect(x).toBeCloseTo(108, 1); // left margin: 1.5 in
    // Orientation is Auto, so the landscape photo is on landscape A4, 841.89 pt
    // wide; the right margin is still the default 10 mm (28.35 pt).
    expect(width).toBeCloseTo(841.89 - 108 - 28.35, 1);
  });
});

test.describe('Source-check closures — sign', () => {
  test('places a stamp on every page in one action', async ({ page }) => {
    await openSign(page, FIXTURE.pdf5page);
    // The signature lands on page 1, selected…
    await addTypedSignature(page, 'Ada Lovelace');
    await expect(page.getByTestId('placed-count')).toHaveText('1 stamp placed');

    // …and one click copies it to the other four. One-per-click would not be "all pages".
    await expect(page.getByTestId('place-all-pages')).toHaveText('Copy to all pages');
    await page.getByTestId('place-all-pages').click();
    await expect(page.getByTestId('placed-count')).toHaveText('5 stamps placed');

    await page.getByTestId('tool-action').click();
    const { bytes } = await expectDownload(
      page,
      () => page.getByTestId('download-button').click(),
      { timeout: 45_000 },
    );
    assertPdf(bytes);
    expect(await countPdfPagesStrict(bytes)).toBe(5);

    // The fixture's pages hold only text and a rectangle, so an XObject paint
    // ("Do") on a page can only be the signature image — and all five need one.
    for (let i = 0; i < 5; i++) {
      const content = (await readPdfContentStreams(bytes, i)).join('\n');
      expect(content, `page ${i + 1} should carry the signature`).toMatch(/\/\S+\s+Do\b/);
    }
  });
});

test.describe('Source-check closures — visual page selectors', () => {
  test('split renders real page thumbnails and syncs them with the range field', async ({ page }) => {
    await page.goto('/split-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    const selector = page.getByTestId('page-selector');
    await expect(selector).toBeVisible({ timeout: 20_000 });

    // Real pixels, not placeholders — this tool already rendered these and threw
    // them away, so "the thumbnails reach the screen" is the whole point.
    const thumbs = selector.getByTestId('page-thumb');
    await expect(thumbs).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect
        .poll(() =>
          thumbs
            .nth(i)
            .locator('img')
            .evaluate((img: HTMLImageElement) => img.naturalWidth)
            .catch(() => 0),
        )
        .toBeGreaterThan(0);
    }

    // Grid -> field.
    await page.getByTestId('page-select-0').click();
    await page.getByTestId('page-select-2').click();
    await expect(page.locator('#split-range')).toHaveValue('1, 3');

    // Field -> grid.
    await page.locator('#split-range').fill('2');
    await expect(page.getByTestId('page-select-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('page-select-0')).toHaveAttribute('aria-pressed', 'false');
  });

  test('pdf-to-image previews the pages it will export', async ({ page }) => {
    await page.goto('/pdf-to-image');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    const selector = page.getByTestId('page-selector');
    await expect(selector).toBeVisible({ timeout: 20_000 });
    await expect(selector.getByTestId('p2i-page-image')).toHaveCount(3);
    await expect
      .poll(() =>
        selector
          .getByTestId('p2i-page-image')
          .first()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);

    // Defaults to all pages selected, and clicking one drops it from the export.
    await expect(selector).toContainText('3 of 3 pages will be exported');
    await page.getByTestId('page-select-1').click();
    await expect(selector).toContainText('2 of 3 pages will be exported');
    await expect(page.getByLabel('Page range to convert')).toHaveValue('1, 3');

    // The preview is a promise about the export, so check the export keeps it.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toHaveText('Download all (2 images)', { timeout: 45_000 });
    // …down to the files: exactly pages 1 and 3 are delivered, under their own
    // page numbers, and page 2 is not among them.
    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 2);
    expect(files.map((f) => f.name).sort()).toEqual(['doc-3page-page-1.png', 'doc-3page-page-3.png']);
    for (const f of files) assertImage(f.bytes, 'png');
  });

  test('pdf-to-image exports nothing when every page is deselected', async ({ page }) => {
    await page.goto('/pdf-to-image');
    await addSingleFileAndWait(page, FIXTURE.pdf1page);

    const selector = page.getByTestId('page-selector');
    await expect(selector.getByTestId('p2i-page-image')).toHaveCount(1);
    await page.getByTestId('page-select-0').click();
    await expect(selector).toContainText('0 of 1 page will be exported');

    // An empty selection used to fall through to "all pages" while the grid said
    // zero — the preview and the export have to agree.
    // The action is disabled and says why, so there is nothing to click through.
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toHaveText(/Select at least one page/i);
    await expect(page.getByTestId('download-button')).toHaveCount(0);
  });
});
