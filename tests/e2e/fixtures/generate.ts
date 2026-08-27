/**
 * Fixture generator — produces real test files used across the e2e suite.
 *
 * PDFs are built in Node with pdf-lib (already a project dependency).
 * Raster images (JPEG/PNG/WebP) are produced by a real browser via canvas
 * during global setup, so we get valid, codec-correct files with no extra deps.
 */
import { PDFDocument, StandardFonts, rgb, cmyk } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
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
  // AcroForm PDF (text field, checkbox, dropdown) — P7 corpus: tools must not
  // silently destroy interactive form fields.
  pdfForm: path.join(FIXTURES_DIR, 'doc-form.pdf'),
  // P7 corpus: documents that are not clean Latin text-only PDFs.
  pdfCjk: path.join(FIXTURES_DIR, 'doc-cjk.pdf'),
  pdfRtl: path.join(FIXTURES_DIR, 'doc-rtl.pdf'),
  pdfCmyk: path.join(FIXTURES_DIR, 'doc-cmyk.pdf'),
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

  // ── AcroForm PDF ───────────────────────────────────────────────────────────
  await writeFile(FIXTURE.pdfForm, await makeFormPdf());

  // ── P7 corpus ──────────────────────────────────────────────────────────────
  await writeFile(FIXTURE.pdfCmyk, await makeCmykPdf());
  // CJK/RTL need a font with those glyphs. Generated when one is present on the
  // host; the corpus tests skip themselves when the fixture is absent rather
  // than pretending to cover a script they never rendered.
  const cjkFont = await findFont(CJK_FONTS);
  if (cjkFont) await writeFile(FIXTURE.pdfCjk, await makeScriptPdf(cjkFont, CJK_TEXT));
  const rtlFont = await findFont(RTL_FONTS);
  if (rtlFont) await writeFile(FIXTURE.pdfRtl, await makeScriptPdf(rtlFont, RTL_TEXT));
}

/** Korean + Han sample. */
export const CJK_TEXT = '한국어 문서 漢字';
/** Hebrew sample (RTL script; pdf-lib applies no bidi reordering or shaping). */
export const RTL_TEXT = 'שלום עולם';

const CJK_FONTS = [
  'C:/Windows/Fonts/malgun.ttf',
  'C:/Windows/Fonts/SimsunExtG.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/Supplemental/AppleGothic.ttf',
];

const RTL_FONTS = [
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

async function findFont(candidates: string[]): Promise<string | null> {
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

/**
 * A PDF whose text is drawn in a real embedded font covering the given script.
 * Subsetted, so the fixture stays small. No bidi reordering or contextual
 * shaping is applied — the point is that the *script and its codepoints* survive
 * our tools, not that the fixture is typographically perfect.
 */
async function makeScriptPdf(fontPath: string, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await readFile(fontPath), { subset: true });
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 800, size: 12, font: latin, color: rgb(0, 0, 0) });
    page.drawText(text, { x: 50, y: 720, size: 24, font, color: rgb(0, 0, 0) });
    page.drawText(text, { x: 50, y: 660, size: 14, font, color: rgb(0.2, 0.2, 0.2) });
  }
  return doc.save();
}

/**
 * A PDF drawn entirely in DeviceCMYK. Print-origin documents use CMYK, and a
 * renderer that assumes RGB either shifts the colours or fails outright.
 */
async function makeCmykPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('CMYK colour test', { x: 50, y: 780, size: 20, font, color: cmyk(0, 0, 0, 1) });
  const swatches = [cmyk(1, 0, 0, 0), cmyk(0, 1, 0, 0), cmyk(0, 0, 1, 0), cmyk(0, 0, 0, 0.5)];
  swatches.forEach((c, i) => {
    page.drawRectangle({ x: 50 + i * 120, y: 600, width: 100, height: 100, color: c });
  });
  page.drawText('Rich black', { x: 50, y: 540, size: 14, font, color: cmyk(0.6, 0.4, 0.4, 1) });
  return doc.save();
}

/**
 * A PDF with real interactive form fields. Premium tools are expected to carry
 * these through (or to say plainly that they flatten them); a tool that drops
 * them silently is losing user data.
 */
async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();

  page.drawText('Application Form', { x: 50, y: 780, size: 20, font, color: rgb(0, 0, 0) });

  page.drawText('Full name', { x: 50, y: 720, size: 12, font });
  const name = form.createTextField('applicant.name');
  name.setText('Ada Lovelace');
  name.addToPage(page, { x: 50, y: 690, width: 300, height: 24 });

  page.drawText('Subscribe', { x: 50, y: 640, size: 12, font });
  const subscribe = form.createCheckBox('applicant.subscribe');
  subscribe.addToPage(page, { x: 130, y: 638, width: 16, height: 16 });
  subscribe.check();

  page.drawText('Plan', { x: 50, y: 590, size: 12, font });
  const plan = form.createDropdown('applicant.plan');
  plan.addOptions(['Free', 'Pro', 'Enterprise']);
  plan.select('Pro');
  plan.addToPage(page, { x: 130, y: 585, width: 160, height: 24 });

  return doc.save();
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
