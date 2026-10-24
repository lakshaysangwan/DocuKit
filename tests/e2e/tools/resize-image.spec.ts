import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, assertImage, assertZip, expectDownload, expectDownloads } from '../helpers/harness';
import {
  chooseBackground,
  chooseFit,
  decodeImage,
  frameLayout,
  halvesImage,
  isBlack,
  isBlue,
  isClear,
  isRed,
  isWhite,
  openOptions,
  openResize,
  openResizeBuffer,
  resizeAndDownload,
  setPercent,
  setSize,
  shownDraw,
} from '../helpers/resize-image';

/**
 * Resize Image. The stage shows the output frame drawn from the layout the
 * writer uses; every test here reads the downloaded file — its format from its
 * first bytes, its pixel size and its pixels — and checks it against what the
 * frame showed.
 */

/** A red-left / blue-right PNG, 1200×800, opened in the tool. */
async function openHalves(page: import('@playwright/test').Page, opts: Parameters<typeof halvesImage>[1] = {}) {
  await page.goto('/resize-image');
  const type = opts.type ?? 'image/png';
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
  const buffer = await halvesImage(page, opts);
  await openResizeBuffer(page, { name: `halves.${ext}`, mimeType: type, buffer });
}

test.describe('Resize Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/resize-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Resize Images');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('on entry the frame is the image at its own size, and the action says why it waits', async ({ page }) => {
    await openResize(page, FIXTURE.jpg); // 1200×800
    await expect(page.getByTestId('file-info')).toContainText('1200 × 800 px');
    expect(await frameLayout(page)).toEqual({ width: 1200, height: 800, draw: { x: 0, y: 0, w: 1200, h: 800 } });
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await expect(page.getByTestId('action-hint')).toContainText('Choose a new size');

    await openOptions(page);
    await page.getByLabel('Width (px)').fill('');
    await expect(page.getByTestId('action-hint')).toContainText('Enter a width and a height');
    await page.getByLabel('Width (px)').fill('20000');
    await expect(page.getByTestId('action-hint')).toContainText('at most 10,000 px');
  });

  test('width with Keep proportions: the height follows and the file is that size', async ({ page }) => {
    await openResize(page, FIXTURE.jpg); // 1200×800
    await openOptions(page);
    await page.getByLabel('Width (px)').fill('600');
    await expect(page.getByLabel('Height (px)')).toHaveValue('400');
    await expect(page.getByTestId('resize-frame')).toHaveAttribute('data-frame', '600,400');

    const { bytes, name } = await resizeAndDownload(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('photo-600x400.jpg');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([600, 400]);

    // After the run the stage shows the file itself, and the facts are read from it.
    await expect(page.getByTestId('stage-status')).toHaveAttribute('data-source', 'output');
    await expect(page.getByTestId('fact-size')).toContainText('600 × 400 px · JPEG');
    await expect
      .poll(() => page.getByTestId('compare-before').evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]))
      .toEqual([600, 400]);
  });

  test('Fit: the whole image inside the frame, white bars where the frame shows them', async ({ page }) => {
    await openHalves(page, { type: 'image/jpeg' });
    await setSize(page, 500, 500);
    await chooseFit(page, 'fit');
    const layout = await frameLayout(page);
    expect(layout.draw.w).toBe(500);
    expect(layout.draw.h).toBeCloseTo(333.33, 1);
    expect(layout.draw.y).toBeCloseTo(83.33, 1);
    // The image is shown in the frame where the layout says.
    const shown = await shownDraw(page);
    expect(shown.y).toBeCloseTo(layout.draw.y / 500, 2);
    expect(shown.h).toBeCloseTo(layout.draw.h / 500, 2);

    const { bytes, name } = await resizeAndDownload(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('halves-500x500.jpg');
    const top = Math.round(layout.draw.y);
    const img = await decodeImage(page, bytes, [
      [250, top - 10], // in the top bar
      [250, top + Math.round(layout.draw.h) + 10], // in the bottom bar
      [100, 250], // left half of the image
      [400, 250], // right half
    ]);
    expect([img.width, img.height]).toEqual([500, 500]);
    expect(isWhite(img.at[0]), `top bar ${img.at[0]}`).toBe(true);
    expect(isWhite(img.at[1]), `bottom bar ${img.at[1]}`).toBe(true);
    expect(isRed(img.at[2]), `left ${img.at[2]}`).toBe(true);
    expect(isBlue(img.at[3]), `right ${img.at[3]}`).toBe(true);
  });

  test('Fit with a black background: the bars are black', async ({ page }) => {
    await openHalves(page, { type: 'image/jpeg', width: 800, height: 1200 });
    await setSize(page, 600, 300);
    await chooseFit(page, 'fit');
    await chooseBackground(page, 'black');
    await expect(page.getByTestId('background-transparent')).toBeDisabled(); // JPEG
    const layout = await frameLayout(page);
    expect(layout.draw.h).toBe(300);
    expect(layout.draw.x).toBeCloseTo(200, 1); // a 200 px wide image in the middle

    const { bytes } = await resizeAndDownload(page);
    const img = await decodeImage(page, bytes, [[20, 150], [580, 150], [300, 150]]);
    expect([img.width, img.height]).toEqual([600, 300]);
    expect(isBlack(img.at[0]), `left bar ${img.at[0]}`).toBe(true);
    expect(isBlack(img.at[1]), `right bar ${img.at[1]}`).toBe(true);
    expect(isBlack(img.at[2])).toBe(false);
  });

  test('Cover: the frame is filled, centred, and a drag picks what is kept — in the file too', async ({ page }) => {
    await openHalves(page);
    await setSize(page, 500, 500);
    await chooseFit(page, 'cover');
    const centred = await frameLayout(page);
    expect(centred.draw).toEqual({ x: -125, y: 0, w: 750, h: 500 });
    await expect(page.getByTestId('resize-frame')).toHaveAttribute('data-pannable', 'true');

    // Drag the image to the right as far as it goes: its left edge is kept.
    const frame = page.getByTestId('resize-frame');
    const box = (await frame.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(box.x + box.width / 2 + i * 40, box.y + box.height / 2);
    await page.mouse.up();
    // The last move may still be committing when the button comes up: wait for it.
    await expect.poll(async () => (await frameLayout(page)).draw.x).toBe(0);
    const dragged = await frameLayout(page);
    await expect(page.getByTestId('crop-position')).toHaveValue('0');

    // Red covers the first half of the drawn image: 0 to 375 px.
    const edge = dragged.draw.x + dragged.draw.w / 2;
    const { bytes, name } = await resizeAndDownload(page);
    assertImage(bytes, 'png');
    expect(name).toBe('halves-500x500.png');
    const img = await decodeImage(page, bytes, [[edge - 8, 250], [edge + 8, 250], [2, 2], [497, 497]]);
    expect([img.width, img.height]).toEqual([500, 500]);
    expect(isRed(img.at[0]), `before the edge ${img.at[0]}`).toBe(true);
    expect(isBlue(img.at[1]), `after the edge ${img.at[1]}`).toBe(true);
    expect(isRed(img.at[2])).toBe(true);
    expect(isBlue(img.at[3])).toBe(true);
  });

  test('Cover: the crop-position slider moves the image too', async ({ page }) => {
    await openHalves(page);
    await setSize(page, 500, 500);
    await chooseFit(page, 'cover');
    await page.getByTestId('crop-position').fill('100');
    const layout = await frameLayout(page);
    expect(layout.draw.x).toBe(-250);
    const { bytes } = await resizeAndDownload(page);
    // The red half now ends at 125 px.
    const img = await decodeImage(page, bytes, [[117, 250], [133, 250]]);
    expect(isRed(img.at[0])).toBe(true);
    expect(isBlue(img.at[1])).toBe(true);
  });

  test('Stretch: the image is pulled to the frame, so the halves meet in the middle', async ({ page }) => {
    await openHalves(page);
    await setSize(page, 500, 200);
    await chooseFit(page, 'stretch');
    expect((await frameLayout(page)).draw).toEqual({ x: 0, y: 0, w: 500, h: 200 });
    const { bytes } = await resizeAndDownload(page);
    const img = await decodeImage(page, bytes, [[242, 100], [258, 100], [2, 2], [497, 197]]);
    expect([img.width, img.height]).toEqual([500, 200]);
    expect(isRed(img.at[0]) && isBlue(img.at[1]) && isRed(img.at[2]) && isBlue(img.at[3])).toBe(true);
  });

  test('Percentage scales the image by its own size', async ({ page }) => {
    await openResize(page, FIXTURE.jpg);
    await setPercent(page, 25);
    await expect(page.getByTestId('resize-frame')).toHaveAttribute('data-frame', '300,200');
    const { bytes, name } = await resizeAndDownload(page);
    expect(name).toBe('photo-300x200.jpg');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([300, 200]);
  });

  test('a transparent PNG stays transparent, bars included; White fills both', async ({ page }) => {
    await openHalves(page, { transparentLeft: true });
    await setSize(page, 400, 400);
    await chooseFit(page, 'fit');
    await expect(page.getByTestId('background-transparent')).toHaveAttribute('aria-pressed', 'true');
    const { bytes, name } = await resizeAndDownload(page);
    assertImage(bytes, 'png');
    expect(name).toBe('halves-400x400.png');
    const img = await decodeImage(page, bytes, [[200, 20], [100, 200], [300, 200]]);
    expect(isClear(img.at[0]), `bar ${img.at[0]}`).toBe(true);
    expect(isClear(img.at[1]), `transparent half ${img.at[1]}`).toBe(true);
    expect(isBlue(img.at[2])).toBe(true);

    await page.getByTestId('edit-again').click();
    await chooseBackground(page, 'white');
    const { bytes: white } = await resizeAndDownload(page);
    const w = await decodeImage(page, white, [[200, 20], [100, 200]]);
    expect(isWhite(w.at[0]) && isWhite(w.at[1])).toBe(true);
  });

  test('a WebP is saved as WebP, named .webp', async ({ page }) => {
    await openResize(page, FIXTURE.webp); // 1000×700
    await setPercent(page, 50);
    const { bytes, name } = await resizeAndDownload(page);
    assertImage(bytes, 'webp');
    expect(name).toBe('image-500x350.webp');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([500, 350]);
  });

  test('the extension follows the real format, not the file name', async ({ page }) => {
    await page.goto('/resize-image');
    const png = await halvesImage(page, { width: 200, height: 100 });
    await openResizeBuffer(page, { name: 'really-a-png.jpg', mimeType: 'image/jpeg', buffer: png });
    await setPercent(page, 50);
    const { bytes, name } = await resizeAndDownload(page);
    assertImage(bytes, 'png');
    expect(name).toBe('really-a-png-100x50.png');
  });

  test('a photo with EXIF orientation is resized the way up it is shown', async ({ page }) => {
    await openResize(page, FIXTURE.jpgRotated); // stored 1200×800, shown 800×1200
    await expect(page.getByTestId('file-info')).toContainText('800 × 1200 px');
    await setPercent(page, 50);
    await expect(page.getByTestId('resize-frame')).toHaveAttribute('data-frame', '400,600');
    const { bytes, name } = await resizeAndDownload(page);
    expect(name).toBe('photo-rotated-400x600.jpg');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([400, 600]);
    // The new file carries no EXIF, so it does not turn a second time.
    expect(bytes.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
  });

  test('an iPhone HEIC photo is read and saved as JPEG', async ({ page }) => {
    await openResize(page, FIXTURE.heic); // 600×400
    await expect(page.getByTestId('file-info')).toContainText('600 × 400 px');
    await setPercent(page, 50);
    const { bytes, name } = await resizeAndDownload(page);
    assertImage(bytes, 'jpeg');
    expect(name).toBe('photo-300x200.jpg');
    const img = await decodeImage(page, bytes);
    expect([img.width, img.height]).toEqual([300, 200]);
  });

  test('batch: one frame for every image, separate downloads or one ZIP', async ({ page }) => {
    await openResize(page, [FIXTURE.jpg, FIXTURE.jpg2]); // 1200×800 and 900×1200
    await expect(page.getByTestId('image-strip-item')).toHaveCount(2);
    await setSize(page, 300, 300);
    await chooseFit(page, 'cover');
    await page.getByTestId('image-strip-item').nth(1).click();
    expect((await frameLayout(page)).draw).toEqual({ x: 0, y: -50, w: 300, h: 400 });

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('batch-fact')).toHaveCount(2);
    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 2);
    expect(files.map((f) => f.name).sort()).toEqual(['photo-2-300x300.jpg', 'photo-300x300.jpg']);
    for (const f of files) {
      assertImage(f.bytes, 'jpeg');
      const img = await decodeImage(page, f.bytes);
      expect([img.width, img.height]).toEqual([300, 300]);
    }
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-zip').click());
    assertZip(bytes);
    expect(name).toBe('resized-images.zip');
  });

  test('custom presets save and persist across a reload (localStorage)', async ({ page }) => {
    await page.goto('/resize-image');
    await page.evaluate(() => localStorage.removeItem('docukit:resize-presets'));
    await openResize(page, FIXTURE.jpg);
    await openOptions(page);
    await page.getByLabel('Width (px)').fill('640');
    await page.getByTestId('save-preset').click();
    await expect(page.getByTestId('custom-preset')).toHaveCount(1);
    await expect(page.getByTestId('custom-preset')).toContainText('640×427');

    await openResize(page, FIXTURE.jpg);
    await openOptions(page);
    await expect(page.getByTestId('custom-preset')).toHaveCount(1);
    await page.getByTestId('custom-preset').getByRole('button', { name: '640×427', exact: true }).click();
    await expect(page.getByTestId('resize-frame')).toHaveAttribute('data-frame', '640,427');
  });

  test('a social preset sets its size; the frame shows the bars Fit leaves', async ({ page }) => {
    await openResize(page, FIXTURE.jpg2); // 900×1200, portrait
    await openOptions(page);
    await page.getByText('Social media presets', { exact: true }).click();
    await page.getByRole('button', { name: /YouTube Thumbnail/ }).click();
    await expect(page.getByLabel('Width (px)')).toHaveValue('1280');
    await expect(page.getByLabel('Height (px)')).toHaveValue('720');
    await expect(page.getByTestId('lock-aspect')).toHaveAttribute('aria-pressed', 'false');
    const layout = await frameLayout(page);
    expect(layout.draw).toEqual({ x: 370, y: 0, w: 540, h: 720 });
    await expect(page.getByTestId('preview-facts')).toContainText('bars left and right');

    const { bytes } = await resizeAndDownload(page);
    const img = await decodeImage(page, bytes, [[100, 360], [1180, 360]]);
    expect([img.width, img.height]).toEqual([1280, 720]);
    expect(isWhite(img.at[0]) && isWhite(img.at[1])).toBe(true);
  });
});
