import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { PDFRawStream } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import { openSign, readDrawnImages, signAndDownload, addTypedSignature } from '../helpers/sign';

/**
 * Sign PDF: a typed signature is drawn in the handwriting style the visitor
 * picked.
 *
 * Until 2026-10 the four signature font files had no basic Latin letters in
 * them (they were the Vietnamese, Cyrillic and Latin Extended slices of each
 * family), so every English name was drawn in whatever script font the system
 * had. A preview that looks right is no proof of that, so this reads the
 * typed image out of the downloaded file and checks it against the same text
 * drawn in the web font alone and in the fallback fonts alone.
 */

const NAME = 'Grace Hopper';
/** Same as the app's typed signature: 96px text, trimmed to ink above alpha 8, 2px padding. */
const SIZE_PX = 96;

/** The four styles in the order the picker shows them: [web font, the fallback stack after it]. */
const STYLES = [
  ['Dancing Script', '"Segoe Script", "Snell Roundhand", "Apple Chancery", cursive'],
  ['Caveat', '"Segoe Print", "Bradley Hand", "Chalkboard SE", cursive'],
  ['Pacifico', '"Brush Script MT", "Lucida Handwriting", "Savoye LET", cursive'],
  ['Sacramento', '"Lucida Handwriting", "Zapfino", "Segoe Script", cursive'],
] as const;

/** The pixel size of `text` drawn the way the app draws a typed signature, in `font`. */
async function inkSize(page: Page, font: string, text: string) {
  return page.evaluate(
    ({ font, text, size }) => {
      const canvas = document.createElement('canvas');
      const measure = canvas.getContext('2d')!;
      measure.font = `${size}px ${font}`;
      canvas.width = Math.ceil(measure.measureText(text).width + size * 2);
      canvas.height = size * 3;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.font = `${size}px ${font}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000000';
      ctx.fillText(text, size, canvas.height / 2);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] <= 8) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const left = Math.max(0, minX - 2);
      const top = Math.max(0, minY - 2);
      return { width: Math.min(width, maxX + 3) - left, height: Math.min(height, maxY + 3) - top };
    },
    { font, text, size: SIZE_PX },
  );
}

/** The one image drawn on page 1 of the signed file: its pixel size and a hash of its alpha mask. */
async function stampedImage(bytes: Buffer) {
  const { PDFDocument, PDFName, PDFDict, PDFNumber } = await import('pdf-lib');
  const { inflateSync } = await import('node:zlib');
  const [drawn] = await readDrawnImages(bytes, 0);
  expect(drawn, 'an image is drawn on the page').toBeTruthy();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const xobjects = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const image = xobjects.lookup(PDFName.of(drawn.name)) as PDFRawStream;
  const num = (key: string) => image.dict.lookup(PDFName.of(key), PDFNumber).asNumber();
  const mask = image.dict.lookup(PDFName.of('SMask')) as PDFRawStream;
  expect(mask, 'a typed signature is a transparent PNG, so it has a soft mask').toBeTruthy();
  const alpha = inflateSync(Buffer.from(mask.getContents()));
  return { width: num('Width'), height: num('Height'), hash: createHash('sha256').update(alpha).digest('hex') };
}

test.describe('Sign PDF — handwriting styles', () => {
  test('every style has the Latin letters, so its own font is used and not a fallback', async ({ page }) => {
    await page.goto('/sign-pdf');
    const results = await page.evaluate(
      async ({ styles }) => {
        const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const ctx = document.createElement('canvas').getContext('2d')!;
        const width = (font: string, text: string) => {
          ctx.font = `48px ${font}`;
          return ctx.measureText(text).width;
        };
        const out = [];
        for (const [web] of styles) {
          await document.fonts.load(`48px "${web}"`, letters);
          // A character the web font has is drawn by it whatever comes next in
          // the stack; one it lacks falls through to monospace or serif, whose
          // widths differ. So a character that measures differently under the
          // two stacks is one the font does not have.
          const missing = [...letters].filter(
            (c) => Math.abs(width(`"${web}", monospace`, c) - width(`"${web}", serif`, c)) > 0.01,
          );
          out.push({
            web,
            loaded: document.fonts.check(`48px "${web}"`, letters),
            missing: missing.join(''),
            own: width(`"${web}", monospace`, letters),
          });
        }
        return out;
      },
      { styles: STYLES },
    );
    for (const r of results) {
      expect(r.loaded, `${r.web} is loaded`).toBe(true);
      expect(r.missing, `letters ${r.web} does not have`).toBe('');
    }
    // And the four are four different fonts.
    expect(new Set(results.map((r) => Math.round(r.own))).size).toBe(STYLES.length);
  });

  test('the typed signature in the downloaded file is drawn in the style picked', async ({ page }) => {
    test.setTimeout(150_000);
    const hashes = new Set<string>();
    for (const [index, [web, fallback]] of STYLES.entries()) {
      // A fresh page each time: the first signature typed on a page is the one
      // that would be drawn before the font had arrived.
      await openSign(page, FIXTURE.pdf1page);
      await page.getByTestId('signature-mode-type').click();
      await page.getByTestId(`signature-font-${index}`).click();
      await addTypedSignature(page, NAME);
      const stamped = await stampedImage(await signAndDownload(page));
      hashes.add(stamped.hash);

      await page.evaluate((web) => document.fonts.load(`${96}px "${web}"`, 'Grace Hopper'), web);
      const own = await inkSize(page, `"${web}"`, NAME);
      const other = await inkSize(page, fallback, NAME);
      const what = `${web}: file ${stamped.width}×${stamped.height}, web font ${own.width}×${own.height}, fallback ${other.width}×${other.height}`;
      expect(Math.abs(stamped.width - own.width), what).toBeLessThanOrEqual(1);
      expect(Math.abs(stamped.height - own.height), what).toBeLessThanOrEqual(1);
      expect(Math.abs(stamped.width - other.width) > 2 || Math.abs(stamped.height - other.height) > 2, what).toBe(true);
    }
    // Four styles, four different images.
    expect(hashes.size).toBe(STYLES.length);
  });
});
