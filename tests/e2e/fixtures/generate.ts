/**
 * Fixture generator — produces real test files used across the e2e suite.
 *
 * PDFs are built in Node with pdf-lib (already a project dependency).
 * Raster images (JPEG/PNG/WebP) are produced by a real browser via canvas
 * during global setup, so we get valid, codec-correct files with no extra deps.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(DIR, 'files');

export const FIXTURE = {
  pdf3page: path.join(FIXTURES_DIR, 'doc-3page.pdf'),
  pdf5page: path.join(FIXTURES_DIR, 'doc-5page.pdf'),
  pdf1page: path.join(FIXTURES_DIR, 'doc-1page.pdf'),
  pdfWide: path.join(FIXTURES_DIR, 'doc-landscape.pdf'),
  // Image-heavy PDF (embedded high-quality JPEGs) for real-compression tests.
  pdfPhoto: path.join(FIXTURES_DIR, 'doc-photo.pdf'),
  jpg: path.join(FIXTURES_DIR, 'photo.jpg'),
  jpg2: path.join(FIXTURES_DIR, 'photo-2.jpg'),
  png: path.join(FIXTURES_DIR, 'graphic.png'),
  webp: path.join(FIXTURES_DIR, 'image.webp'),
} as const;

async function makePdf(pages: number, landscape = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size: [number, number] = landscape ? [792, 612] : [612, 792];
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(size);
    const { width, height } = page.getSize();
    page.drawText(`Test Document`, { x: 60, y: height - 90, size: 32, font: bold, color: rgb(0.1, 0.1, 0.4) });
    page.drawText(`Page ${i + 1} of ${pages}`, { x: 60, y: height - 130, size: 18, font, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(`This is sample body text for functional testing of Docukit.`, {
      x: 60, y: height - 180, size: 12, font, color: rgb(0, 0, 0),
    });
    // A visible rectangle so thumbnails are clearly non-blank.
    page.drawRectangle({ x: 60, y: 120, width: width - 120, height: 200, borderColor: rgb(0.4, 0.4, 0.9), borderWidth: 2 });
  }
  return doc.save();
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function generateFixtures(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });

  // ── PDFs (node) ──────────────────────────────────────────────────────────
  await writeFile(FIXTURE.pdf3page, await makePdf(3));
  await writeFile(FIXTURE.pdf5page, await makePdf(5));
  await writeFile(FIXTURE.pdf1page, await makePdf(1));
  await writeFile(FIXTURE.pdfWide, await makePdf(2, true));

  // ── Images (browser canvas) ───────────────────────────────────────────────
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Passed as a STRING so tsx/esbuild does not inject __name helpers that break
  // inside the browser context.
  const browserScript = `(async () => {
    const draw = (w, h, hue) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, 'hsl(' + hue + ',70%,55%)');
      g.addColorStop(1, 'hsl(' + ((hue + 80) % 360) + ',70%,35%)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'white';
      ctx.font = 'bold ' + Math.round(w / 10) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('TEST', w / 2, h / 2);
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(Math.random() * w, Math.random() * h, 20 + Math.random() * 40, 0, Math.PI * 2);
        ctx.fillStyle = 'hsla(' + (Math.random() * 360) + ',80%,60%,0.4)';
        ctx.fill();
      }
      return c;
    };
    const toB64 = async (c, type, q) => {
      const blob = await new Promise((res) => c.toBlob((b) => res(b), type, q));
      const buf = await blob.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    };
    return {
      jpg: await toB64(draw(1200, 800, 210), 'image/jpeg', 0.92),
      jpg2: await toB64(draw(900, 1200, 20), 'image/jpeg', 0.9),
      png: await toB64(draw(800, 800, 140), 'image/png'),
      webp: await toB64(draw(1000, 700, 300), 'image/webp', 0.9),
    };
  })()`;
  const encoded = await page.evaluate(browserScript) as Record<'jpg' | 'jpg2' | 'png' | 'webp', string>;
  await browser.close();

  await writeFile(FIXTURE.jpg, Buffer.from(encoded.jpg, 'base64'));
  await writeFile(FIXTURE.jpg2, Buffer.from(encoded.jpg2, 'base64'));
  await writeFile(FIXTURE.png, Buffer.from(encoded.png, 'base64'));
  await writeFile(FIXTURE.webp, Buffer.from(encoded.webp, 'base64'));

  // ── Image-heavy PDF (node) ─────────────────────────────────────────────────
  // Embeds the high-quality JPEGs full-page so image recompression has real work
  // to do — text-only PDFs have nothing to shrink.
  await writeFile(FIXTURE.pdfPhoto, await makePhotoPdf(encoded.jpg, encoded.jpg2));
}

async function makePhotoPdf(jpgB64: string, jpg2B64: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const a = await doc.embedJpg(Buffer.from(jpgB64, 'base64'));
  const b = await doc.embedJpg(Buffer.from(jpg2B64, 'base64'));
  // Four full-page images → a few hundred KB of DCTDecode streams to recompress.
  for (const img of [a, b, a, b]) {
    const page = doc.addPage([612, 792]);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save();
}

// Allow running standalone: `tsx tests/e2e/fixtures/generate.ts`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate.ts')) {
  const already = await exists(FIXTURE.pdf3page);
  await generateFixtures();
  console.log(already ? 'Fixtures regenerated.' : 'Fixtures generated.');
}
