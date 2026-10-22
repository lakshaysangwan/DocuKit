import { type Page, type Locator, expect } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { uploadFiles, expectDownload, assertPdf } from './harness';

/**
 * Helpers for Digital Signature PDF: drive the workspace, and read back from
 * the DOWNLOADED file where the signature widget is, as a rectangle of the
 * displayed page — mapped by pdf.js's own viewport, not by the app's geometry.
 */

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Open the tool with a PDF and wait for its first page to be drawn. */
export async function openDigitalSignature(page: Page, pdf: string) {
  await page.goto('/digital-signature-pdf');
  await uploadFiles(page, pdf);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** Open the phone Options panel if it is closed (a no-op from 768px up). */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

/** Type a name for the self-signed certificate (the default source). */
export async function enterName(page: Page, name = 'Ada Lovelace') {
  await openOptions(page);
  await page.getByPlaceholder('John Doe').fill(name);
}

export function signatureBox(page: Page): Locator {
  return page.locator('[data-testid="overlay-item"][data-kind="signature-box"]');
}

/** Go to a page (1-based) with the pager and wait for it to be drawn. */
export async function goToPage(page: Page, pageNumber: number) {
  for (let guard = 0; guard < 60; guard++) {
    const shown = Number(await page.getByTestId('page-canvas').getAttribute('data-page'));
    if (shown === pageNumber) break;
    await page.getByTestId(shown < pageNumber ? 'page-next' : 'page-prev').click();
  }
  await expect(page.getByTestId('page-canvas')).toHaveAttribute('data-page', String(pageNumber));
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** Where the box is on screen, as fractions of the page it sits on. */
export async function boxViewRect(page: Page): Promise<ViewRect> {
  const box = signatureBox(page);
  await expect(box).toBeVisible();
  return box.evaluate((el) => {
    const canvas = el.closest('[data-testid="page-canvas"]')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - canvas.left) / canvas.width,
      y: (r.top - canvas.top) / canvas.height,
      width: r.width / canvas.width,
      height: r.height / canvas.height,
    };
  });
}

/** Drag the box by (dx, dy) CSS pixels with the mouse, then pull its bottom-right corner by (rx, ry). */
export async function dragBox(page: Page, dx: number, dy: number, rx = 0, ry = 0) {
  const box = signatureBox(page);
  const b = (await box.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
  if (rx || ry) {
    const handle = box.getByTestId('overlay-handle-bottom-right');
    const h = (await handle.boundingBox())!;
    const hx = h.x + h.width / 2;
    const hy = h.y + h.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(hx + (rx * i) / 8, hy + (ry * i) / 8);
    await page.mouse.up();
  }
}

/** Set the box with the millimetre fields. */
export async function setBoxMm(page: Page, mm: { x?: number; y?: number; width?: number; height?: number }) {
  await openOptions(page);
  // Size first: it keeps the top-left corner, and X/Y then place that corner.
  if (mm.width !== undefined) await page.getByTestId('box-width').fill(String(mm.width));
  if (mm.height !== undefined) await page.getByTestId('box-height').fill(String(mm.height));
  if (mm.x !== undefined) await page.getByTestId('box-x').fill(String(mm.x));
  if (mm.y !== undefined) await page.getByTestId('box-y').fill(String(mm.y));
  await page.getByTestId('box-y').blur();
}

/** Press the action, wait for the download to replace it, and fetch the file. */
export async function signAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  expect(name).toMatch(/-signed\.pdf$/);
  return bytes;
}

export interface Widget {
  pageIndex: number;
  /** The widget's /Rect on the displayed page, by pdf.js. */
  rect: ViewRect;
  /** Zero width or height: an invisible signature. */
  empty: boolean;
}

/** Every signature widget in the file, page by page. */
export async function readSignatureWidgets(bytes: Buffer): Promise<Widget[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  const out: Widget[] = [];
  try {
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });
      for (const a of (await page.getAnnotations()) as any[]) {
        if (a.fieldType !== 'Sig') continue;
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
        const rect = {
          x: Math.min(x1, x2) / viewport.width,
          y: Math.min(y1, y2) / viewport.height,
          width: Math.abs(x2 - x1) / viewport.width,
          height: Math.abs(y2 - y1) / viewport.height,
        };
        out.push({ pageIndex: i, rect, empty: rect.width * rect.height === 0 });
      }
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

export interface SignatureField {
  /** The field's normal appearance, if it has one. */
  appearance: { bbox: number[]; matrix: number[]; content: string } | null;
  /** /F flags. */
  flags: number;
  /** /Type, /SubFilter and /Contents length of the signature dictionary. */
  type: string;
  subFilter: string;
  contentsHexLength: number;
}

/** The signature fields of the AcroForm, read with pdf-lib. */
export async function readSignatureFields(bytes: Buffer): Promise<SignatureField[]> {
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  const form = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const fields = form.lookup(PDFName.of('Fields'), PDFArray);
  const out: SignatureField[] = [];
  for (let i = 0; i < fields.size(); i++) {
    const field = fields.lookup(i, PDFDict);
    if (field.get(PDFName.of('FT'))?.toString() !== '/Sig') continue;
    const sig = field.lookup(PDFName.of('V'), PDFDict);
    const ap = field.lookupMaybe(PDFName.of('AP'), PDFDict);
    let appearance: SignatureField['appearance'] = null;
    if (ap) {
      const n = ap.lookup(PDFName.of('N')) as PDFRawStream;
      const nums = (name: string) =>
        n.dict.lookup(PDFName.of(name), PDFArray).asArray().map((v) => (v as PDFNumber).asNumber());
      appearance = { bbox: nums('BBox'), matrix: nums('Matrix'), content: Buffer.from(n.getContents()).toString('latin1') };
    }
    out.push({
      appearance,
      flags: (field.lookup(PDFName.of('F'), PDFNumber)).asNumber(),
      type: sig.get(PDFName.of('Type'))?.toString() ?? '',
      subFilter: sig.get(PDFName.of('SubFilter'))?.toString() ?? '',
      contentsHexLength: sig.get(PDFName.of('Contents'))!.toString().length - 2,
    });
  }
  return out;
}

/** The /ByteRange as written, and the bytes it leaves out. */
export function readByteRange(bytes: Buffer): { range: number[]; gap: string } {
  const text = bytes.toString('latin1');
  const m = text.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  expect(m, 'a /ByteRange').not.toBeNull();
  const range = m!.slice(1, 5).map(Number);
  return { range, gap: text.slice(range[0] + range[1], range[2]) };
}

/** A .p12 file holding a fresh RSA-2048 key and self-signed certificate, encrypted with `password`. */
export async function makeP12(cn: string, password: string): Promise<Buffer> {
  const mod = (await import('node-forge')) as any;
  const forge = mod.default ?? mod;
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/** Each side of `actual` within `tolerance` (fractions of the page) of `expected`. */
export function expectSameRect(actual: ViewRect, expected: ViewRect, tolerance = 0.005) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${k}: ${actual[k]} vs ${expected[k]}`).toBeLessThanOrEqual(tolerance);
  }
}
