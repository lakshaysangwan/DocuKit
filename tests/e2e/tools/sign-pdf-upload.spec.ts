import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { FIXTURE } from '../fixtures/generate';
import { SIGNATURE_PHOTO, signaturePhotoInkBox } from '../fixtures/sign-fixtures';
import { renderPage } from '../helpers/redact-pdf';
import { dropFile } from '../helpers/harness';
import { expectHeicPhotoOnPage } from '../helpers/heic-photo';
import {
  chooseSignaturePicture,
  openSign,
  readDrawnImages,
  readStoredImage,
  signAndDownload,
  type StoredImage,
} from '../helpers/sign';

/**
 * Sign PDF, Upload tab: a photo of a signature on paper becomes just the ink.
 *
 * Everything here is read from the downloaded file: the image stored in it
 * (its RGB and its soft mask) and a render of the signed page by a second
 * renderer (MuPDF), compared with the page before signing.
 */

const P = SIGNATURE_PHOTO;
const INK = signaturePhotoInkBox();
/** The app keeps this many clear pixels round the ink. */
const MARGIN = 4;

/** Distance from a photo pixel to the nearest ink (stroke centre line or dot centre), minus the ink's own half-width. */
function distanceToInk(x: number, y: number): number {
  let d = Infinity;
  for (let k = 1; k < P.stroke.length; k++) {
    const [ax, ay] = P.stroke[k - 1];
    const [bx, by] = P.stroke[k];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - P.pen / 2);
  }
  return Math.min(d, Math.hypot(x - P.dot.x, y - P.dot.y) - P.dot.r);
}

/** Map a pixel of the stored stamp image back to the photo. */
function toPhoto(img: StoredImage, u: number, v: number): [number, number] {
  const boxW = INK.x1 - INK.x0 + 1 + 2 * MARGIN;
  const boxH = INK.y1 - INK.y0 + 1 + 2 * MARGIN;
  return [INK.x0 - MARGIN + ((u + 0.5) * boxW) / img.width, INK.y0 - MARGIN + ((v + 0.5) * boxH) / img.height];
}

/** Watch every request the page makes from now on. */
function recordRequests(page: Page) {
  const seen: Request[] = [];
  page.on('request', (r) => seen.push(r));
  return seen;
}

function expectNothingSent(requests: Request[], baseURL: string) {
  const origin = new URL(baseURL).origin;
  for (const r of requests) {
    const what = `${r.method()} ${r.url()}`;
    expect(r.method(), what).toBe('GET');
    expect(r.postDataBuffer(), what).toBeNull();
    const url = new URL(r.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') expect(url.origin, what).toBe(origin);
  }
}

/** The preview canvas: its size and how many pixels have any ink. */
async function previewInk(page: Page, inkFor?: string) {
  const preview = page.getByTestId('signature-upload-preview');
  // The ink shown must be the one made with these settings, not the one before.
  if (inkFor) await expect(preview).toHaveAttribute('data-ink-for', inkFor, { timeout: 30_000 });
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return page.getByTestId('signature-upload-canvas').evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    return { width: c.width, height: c.height, ink };
  });
}

async function useCleanedPhoto(page: Page, black = false) {
  await chooseSignaturePicture(page, FIXTURE.signPhoto);
  // Cleaned is the default for a photo.
  await expect(page.getByTestId('signature-view-cleaned')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('signature-upload-preview')).toHaveAttribute('data-view', 'cleaned');
  if (black) {
    await page.getByTestId('signature-ink-black').check();
    await previewInk(page, '50-black');
  }
  await expect(page.getByTestId('use-signature')).toBeEnabled();
  await page.getByTestId('use-signature').click();
  await expect(page.getByTestId('overlay-item').first()).toBeVisible();
}

test.describe('Sign PDF — signature from a photo', () => {
  test('the paper is taken out and the stamp is cropped to the ink, in its own blue', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await openSign(page, FIXTURE.pdf1page);
    const requests = recordRequests(page);
    await useCleanedPhoto(page);
    // Nothing went anywhere while the picture was read and cleaned.
    expectNothingSent(requests, baseURL!);

    const bytes = await signAndDownload(page);
    const drawn = await readDrawnImages(bytes, 0);
    expect(drawn).toHaveLength(1);
    const img = await readStoredImage(bytes, drawn[0].name, 0);
    expect(img.alpha, 'the stamp has an alpha channel').not.toBeNull();
    const alpha = img.alpha!;
    const a = (u: number, v: number) => alpha[v * img.width + u];
    const rgb = (u: number, v: number) => [0, 1, 2].map((c) => img.rgb[(v * img.width + u) * 3 + c]);

    // Cropped to the ink box (plus the margin), not the whole photo.
    const inkAspect = (INK.x1 - INK.x0 + 1 + 2 * MARGIN) / (INK.y1 - INK.y0 + 1 + 2 * MARGIN);
    const imageAspect = img.width / img.height;
    expect(Math.abs(imageAspect / inkAspect - 1), `image ${img.width}×${img.height}, ink box aspect ${inkAspect.toFixed(3)}`).toBeLessThan(0.03);
    expect(Math.abs(imageAspect - P.width / P.height)).toBeGreaterThan(0.5);
    // Drawn on the page with that same shape (Letter: 612 × 792 pt).
    const shownAspect = (drawn[0].rect.width * 612) / (drawn[0].rect.height * 792);
    expect(Math.abs(shownAspect / imageAspect - 1)).toBeLessThan(0.01);

    // The corners and every pixel well away from the strokes are fully clear.
    for (const [u, v] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) {
      expect(a(u, v), `corner ${u},${v}`).toBe(0);
    }
    let paper = 0;
    let paperShowing = 0;
    for (let v = 0; v < img.height; v++) {
      for (let u = 0; u < img.width; u++) {
        if (distanceToInk(...toPhoto(img, u, v)) < 10) continue;
        paper++;
        if (a(u, v) !== 0) paperShowing++;
      }
    }
    expect(paper).toBeGreaterThan(img.width * img.height * 0.5);
    expect(paperShowing, `${paperShowing} of ${paper} paper pixels are not clear`).toBe(0);

    // The stroke is opaque and blue, all along it and in the dot.
    const scale = img.width / (INK.x1 - INK.x0 + 1 + 2 * MARGIN);
    const toImage = (x: number, y: number): [number, number] => [
      Math.round((x - (INK.x0 - MARGIN)) * scale - 0.5),
      Math.round((y - (INK.y0 - MARGIN)) * scale - 0.5),
    ];
    for (const [x, y] of [...P.stroke, [P.dot.x, P.dot.y] as [number, number]]) {
      const [u, v] = toImage(x, y);
      const [r, g, b] = rgb(u, v);
      expect(a(u, v), `alpha on the stroke at ${x},${y}`).toBeGreaterThanOrEqual(250);
      expect(b, `blue at ${x},${y}: ${r},${g},${b}`).toBeGreaterThan(r + 50);
      expect(b, `blue at ${x},${y}: ${r},${g},${b}`).toBeGreaterThan(g + 30);
    }
    // Soft edges: partly clear pixels between the ink and the paper.
    let soft = 0;
    for (const value of alpha) if (value > 0 && value < 255) soft++;
    expect(soft).toBeGreaterThan(100);

    // On the page, where the stamp is clear the page is exactly the page.
    const before = await renderPage(readFileSync(FIXTURE.pdf1page), 0, 1.5);
    const after = await renderPage(bytes, 0, 1.5);
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    const { rect } = drawn[0];
    // A render pixel covers several stamp pixels: look that far round it, and a pixel more.
    const reach = Math.ceil(img.width / (rect.width * after.width)) + 2;
    let checked = 0;
    let worst = 0;
    let changed = 0;
    let inked = 0;
    for (let py = Math.ceil(rect.y * after.height); py < Math.floor((rect.y + rect.height) * after.height); py++) {
      for (let px = Math.ceil(rect.x * after.width); px < Math.floor((rect.x + rect.width) * after.width); px++) {
        const u = Math.floor(((px + 0.5) / after.width - rect.x) / rect.width * img.width);
        const v = Math.floor(((py + 0.5) / after.height - rect.y) / rect.height * img.height);
        let clear = true;
        for (let dv = -reach; dv <= reach && clear; dv++) {
          for (let du = -reach; du <= reach && clear; du++) {
            const uu = Math.min(img.width - 1, Math.max(0, u + du));
            const vv = Math.min(img.height - 1, Math.max(0, v + dv));
            if (a(uu, vv) !== 0) clear = false;
          }
        }
        const i = (py * after.width + px) * 3;
        const diff = Math.max(...[0, 1, 2].map((c) => Math.abs(after.data[i + c] - before.data[i + c])));
        if (!clear) {
          if (a(u, v) === 255 && diff > 60) inked++;
          continue;
        }
        checked++;
        if (diff > 2) changed++;
        worst = Math.max(worst, diff);
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(changed, `${changed} of ${checked} page pixels under clear parts of the stamp changed, by up to ${worst}`).toBe(0);
    expect(inked, 'the ink itself is drawn on the page').toBeGreaterThan(200);
  });

  test('"Make ink black" stamps the ink black', async ({ page }) => {
    test.setTimeout(90_000);
    await openSign(page, FIXTURE.pdf1page);
    await useCleanedPhoto(page, true);
    const bytes = await signAndDownload(page);
    const [drawn] = await readDrawnImages(bytes, 0);
    const img = await readStoredImage(bytes, drawn.name, 0);
    const alpha = img.alpha!;
    expect(alpha).not.toBeNull();
    let opaque = 0;
    for (let p = 0; p < alpha.length; p++) {
      if (alpha[p] < 250) continue;
      opaque++;
      expect(Math.max(img.rgb[p * 3], img.rgb[p * 3 + 1], img.rgb[p * 3 + 2])).toBeLessThan(40);
    }
    expect(opaque).toBeGreaterThan(500);
    expect(alpha[0]).toBe(0);
  });

  test('the Sensitivity slider changes what is kept, and Original shows the photo as it is', async ({ page }) => {
    await openSign(page, FIXTURE.pdf1page);
    await chooseSignaturePicture(page, FIXTURE.signPhoto);
    const base = await previewInk(page, '50');
    // Cropped to the ink, not the photo.
    expect(base.width).toBeLessThan(P.width * 0.6);

    await page.getByTestId('signature-sensitivity').fill('100');
    const more = await previewInk(page, '100');
    await page.getByTestId('signature-sensitivity').fill('0');
    const less = await previewInk(page, '0');
    expect(more.ink).toBeGreaterThan(base.ink);
    expect(less.ink).toBeLessThan(base.ink);

    await page.getByTestId('signature-view-original').click();
    await expect(page.getByTestId('signature-upload-preview')).toHaveAttribute('data-view', 'original');
    await expect(page.getByTestId('signature-sensitivity')).toBeDisabled();
    const original = await previewInk(page);
    expect([original.width, original.height]).toEqual([P.width, P.height]);
  });

  test('a sideways phone photo is turned upright, and an iPhone HEIC is accepted', async ({ page }) => {
    test.setTimeout(90_000);
    await openSign(page, FIXTURE.pdf1page);
    // Stored 1200 × 800 with EXIF Orientation 6: shown 800 × 1200.
    await chooseSignaturePicture(page, FIXTURE.jpgRotated);
    await page.getByTestId('signature-view-original').click();
    const rotated = await previewInk(page);
    expect([rotated.width, rotated.height]).toEqual([800, 1200]);

    await page.getByTestId('signature-upload-replace').click();
    await chooseSignaturePicture(page, FIXTURE.heic);
    await page.getByTestId('signature-view-original').click();
    const heic = await previewInk(page);
    expect([heic.width, heic.height]).toEqual([600, 400]);
    await expect(page.getByTestId('use-signature')).toBeEnabled();
  });

  test('a HEIC dropped with no MIME type (as Windows gives it) is taken and is the photo in the signed PDF', async ({ page }) => {
    test.slow();
    await openSign(page, FIXTURE.pdf1page);
    await page.getByTestId('signature-mode-upload').click();
    const zone = page.getByTestId('signature-upload');
    await expect(zone.locator('[data-testid="dropzone"][data-hydrated="true"]')).toBeVisible();
    const input = zone.locator('input[type="file"]');
    await expect(input).toHaveAttribute('accept', /image\/gif.*image\/avif.*\.heic/);
    // Dropped: a file input given a .heic name gets image/heic from the browser, a drop keeps the empty type.
    await dropFile(zone.getByTestId('dropzone'), { name: 'IMG_0001.HEIC', mimeType: '', buffer: readFileSync(FIXTURE.heic) });
    await expect(page.getByTestId('signature-upload-preview')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('signature-view-original').click();
    await expect(page.getByTestId('signature-upload-preview')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await page.getByTestId('use-signature').click();
    await expect(page.getByTestId('overlay-item').first()).toBeVisible();

    const pdf = await signAndDownload(page);
    await expectHeicPhotoOnPage(pdf, 0);
  });
});
