/**
 * Digital signatures against real PDFs and an independent renderer.
 *
 * For a plain page, every /Rotate and an offset CropBox this signs with a
 * visible box at a known rectangle of the displayed page and checks, in the
 * written file:
 *
 *   • the widget's /Rect, mapped to the displayed page by pdf.js, is that rectangle;
 *   • MuPDF renders the box there — its blue border on all four sides — with the
 *     text starting at the box's left and nothing in its right third or top
 *     strip, so the text reads upright on the displayed page;
 *   • the signature itself checks out: ByteRange over the whole file but the
 *     /Contents string, digest, RSA signature, signer.
 *
 * And that an invisible signature has a zero-size widget with no appearance
 * and draws nothing; and that a wrong .p12 password says so.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, degrees, rgb } from 'pdf-lib';
import * as forgeNs from 'node-forge';
import { makePageGeometry, type PageGeometry, type RectNorm } from './pdf/page-geometry';
import { generateSelfSignedCert, loadP12, signPdfWithPkcs7, WRONG_CERT_PASSWORD_MESSAGE, uniqueFieldName } from './pdf-sign';
import { checkSignedPdf } from './pdf-sign-check';

const forge = ((forgeNs as any).default ?? forgeNs) as typeof forgeNs;

type Rgb = [number, number, number];
type Cert = Awaited<ReturnType<typeof generateSelfSignedCert>>;

let cert: Cert;
beforeAll(async () => {
  cert = await generateSelfSignedCert({ cn: 'Ada Lovelace' });
}, 120_000);

interface Spec {
  name: string;
  rotate: 0 | 90 | 180 | 270;
  media: [number, number, number, number];
  crop?: [number, number, number, number];
}

const SPECS: Spec[] = [
  ...([0, 90, 180, 270] as const).map((rotate): Spec => ({ name: `/Rotate ${rotate}`, rotate, media: [0, 0, 612, 792] })),
  { name: 'offset CropBox', rotate: 0, media: [0, 0, 612, 792], crop: [50, 80, 550, 700] },
  { name: '/Rotate 90 with an offset CropBox', rotate: 90, media: [0, 0, 612, 792], crop: [50, 80, 550, 700] },
];

/** A two-page file; page 2 (index 1) is the awkward one. */
async function build(spec: Spec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const page = doc.addPage([spec.media[2], spec.media[3]]);
  page.setMediaBox(...spec.media);
  if (spec.crop) page.setCropBox(...spec.crop);
  if (spec.rotate) page.setRotation(degrees(spec.rotate));
  page.drawRectangle({ x: spec.media[0], y: spec.media[1], width: spec.media[2], height: spec.media[3], color: rgb(1, 1, 1) });
  return doc.save();
}

async function pdfjsPage(bytes: Uint8Array, pageIndex: number) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  const page = await doc.getPage(pageIndex + 1);
  return { doc, page };
}

async function geometryOf(bytes: Uint8Array, pageIndex: number): Promise<PageGeometry> {
  const { doc, page } = await pdfjsPage(bytes, pageIndex);
  try {
    return makePageGeometry({ view: page.view, rotate: page.rotate, userUnit: page.userUnit });
  } finally {
    await doc.destroy();
  }
}

/** Every signature widget on a page, its Rect mapped to the displayed page by pdf.js. */
async function widgetsInView(bytes: Uint8Array, pageIndex: number): Promise<RectNorm[]> {
  const { doc, page } = await pdfjsPage(bytes, pageIndex);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const annots = await page.getAnnotations();
    return annots
      .filter((a: any) => a.fieldType === 'Sig')
      .map((a: any) => {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
        return {
          x: Math.min(x1, x2) / viewport.width,
          y: Math.min(y1, y2) / viewport.height,
          width: Math.abs(x2 - x1) / viewport.width,
          height: Math.abs(y2 - y1) / viewport.height,
        };
      });
  } finally {
    await doc.destroy();
  }
}

async function render(bytes: Uint8Array, pageIndex: number, pixelsPerPoint = 2) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    const pix = page.toPixmap(mupdf.Matrix.scale(pixelsPerPoint, pixelsPerPoint), mupdf.ColorSpace.DeviceRGB, false);
    const width = pix.getWidth(), height = pix.getHeight(), stride = pix.getStride(), n = pix.getNumberOfComponents();
    const pixels = pix.getPixels().slice();
    const at = (x: number, y: number): Rgb => {
      const o = y * stride + x * n;
      return [pixels[o], pixels[o + 1], pixels[o + 2]];
    };
    /** Pixels in a region of the displayed page (fractions) matching `test`. */
    const count = (r: RectNorm, test: (c: Rgb) => boolean) => {
      let hits = 0;
      for (let y = Math.floor(r.y * height); y < Math.ceil((r.y + r.height) * height); y++) {
        for (let x = Math.floor(r.x * width); x < Math.ceil((r.x + r.width) * width); x++) {
          if (x >= 0 && y >= 0 && x < width && y < height && test(at(x, y))) hits++;
        }
      }
      return hits;
    };
    return { width, height, count };
  } finally {
    doc.destroy();
  }
}

const near = (c: Rgb, w: Rgb, tol = 45) => c.every((v, i) => Math.abs(v - w[i]) <= tol);
const BORDER: Rgb = [51, 102, 204];
const isText = (c: Rgb) => c[0] < 90 && c[1] < 110 && c[2] < 170;
const isBorder = (c: Rgb) => near(c, BORDER);

const BOX: RectNorm = { x: 0.15, y: 0.3, width: 0.5, height: 0.12 };

function sub(r: RectNorm, x: number, y: number, w: number, h: number): RectNorm {
  return { x: r.x + x * r.width, y: r.y + y * r.height, width: w * r.width, height: h * r.height };
}

describe.each(SPECS)('visible box on page 2: $name', (spec) => {
  it('lands where it was placed, reads upright, and the signature checks out', async () => {
    const input = await build(spec);
    const geometry = await geometryOf(input, 1);
    const date = new Date('2026-10-23T12:00:00Z');
    const out = new Uint8Array(
      await signPdfWithPkcs7(input.slice().buffer, cert.privateKey, cert.certificate, {
        visible: { pageIndex: 1, geometry, rect: BOX },
        date,
      }),
    );

    // The widget is on page 2 only, at the box (within 0.5% of the page).
    expect(await widgetsInView(out, 0)).toEqual([]);
    const [widget, ...more] = await widgetsInView(out, 1);
    expect(more).toEqual([]);
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(widget[k] - BOX[k]), k).toBeLessThan(0.005);

    // It has an appearance, turned with the page.
    const doc = await PDFDocument.load(out);
    const annots = doc.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
    const field = doc.context.lookup(annots.get(annots.size() - 1), PDFDict);
    const ap = field.lookup(PDFName.of('AP'), PDFDict);
    const normal = ap.lookup(PDFName.of('N')) as PDFRawStream;
    const matrix = normal.dict.lookup(PDFName.of('Matrix'), PDFArray).asArray().map((v) => (v as PDFNumber).asNumber());
    const rad = (spec.rotate * Math.PI) / 180;
    expect(matrix.map((v) => Math.round(v) + 0)).toEqual([Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0].map((v) => Math.round(v) + 0));

    // MuPDF draws it there: border on all four sides, text from the left, upright.
    const page = await render(out, 1);
    const edge = 0.04;
    expect(page.count(sub(BOX, 0, 0.3, edge, 0.4), isBorder), 'left border').toBeGreaterThan(0);
    expect(page.count(sub(BOX, 1 - edge, 0.3, edge, 0.4), isBorder), 'right border').toBeGreaterThan(0);
    expect(page.count(sub(BOX, 0.3, 0, 0.4, edge * 2), isBorder), 'top border').toBeGreaterThan(0);
    expect(page.count(sub(BOX, 0.3, 1 - edge * 2, 0.4, edge * 2), isBorder), 'bottom border').toBeGreaterThan(0);
    expect(page.count(sub(BOX, 0.02, 0.2, 0.3, 0.6), isText), 'text at the left').toBeGreaterThan(20);
    expect(page.count(sub(BOX, 0.7, 0.05, 0.28, 0.9), isText), 'nothing in the right third').toBe(0);
    expect(page.count(sub(BOX, 0.05, 0.05, 0.9, 0.12), isText), 'nothing in the top strip').toBe(0);
    // Nothing of the box outside it.
    expect(page.count({ x: 0, y: 0, width: 1, height: Math.max(0, BOX.y - 0.01) }, isBorder), 'above the box').toBe(0);

    const check = await checkSignedPdf(out);
    expect(check.coversWholeFile).toBe(true);
    expect(check.byteRange[0]).toBe(0);
    expect(check.byteRange[2] + check.byteRange[3]).toBe(out.length);
    expect(check.unsignedBytes).toBe(8192 * 2 + 2);
    expect(check.digestMatches).toBe(true);
    expect(check.signatureValid).toBe(true);
    expect(check.signerName).toBe('Ada Lovelace');
    expect(check.selfSigned).toBe(true);
    expect(check.signingTime?.toISOString()).toBe(date.toISOString());
  }, 60_000);
});

describe('invisible signature', () => {
  it('has a zero-size widget with no appearance, draws nothing, and checks out', async () => {
    const input = await build(SPECS[0]);
    const out = new Uint8Array(await signPdfWithPkcs7(input.slice().buffer, cert.privateKey, cert.certificate, { visible: null }));
    for (const i of [0, 1]) {
      for (const w of await widgetsInView(out, i)) expect(w.width * w.height).toBe(0);
    }
    const doc = await PDFDocument.load(out);
    const fields = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray);
    expect(fields.size()).toBe(1);
    const field = doc.context.lookup(fields.get(0), PDFDict);
    expect(field.get(PDFName.of('AP'))).toBeUndefined();
    expect(field.lookup(PDFName.of('V'), PDFDict).get(PDFName.of('Type'))?.toString()).toBe('/Sig');

    for (const i of [0, 1]) {
      const page = await render(out, i, 1);
      expect(page.count({ x: 0, y: 0, width: 1, height: 1 }, (c) => c.some((v) => v < 250))).toBe(0);
    }

    const check = await checkSignedPdf(out);
    expect(check.coversWholeFile && check.digestMatches && check.signatureValid).toBe(true);
  }, 60_000);

  it('keeps the annotations a page already had', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 50] }));
    // An indirect /Annots array, which a plain `get` would not see as an array.
    page.node.set(PDFName.of('Annots'), doc.context.register(doc.context.obj([link])));
    const out = await signPdfWithPkcs7((await doc.save()).slice().buffer, cert.privateKey, cert.certificate, { visible: null });
    const back = await PDFDocument.load(new Uint8Array(out));
    const annots = back.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(2);
    expect(annots.get(0)).toBeInstanceOf(PDFRef);
  }, 60_000);
});

describe('certificate files', () => {
  async function p12(password: string): Promise<ArrayBuffer> {
    const asn1 = forge.pkcs12.toPkcs12Asn1(cert.privateKey, cert.certificate, password, { algorithm: '3des' });
    const der = forge.asn1.toDer(asn1).getBytes();
    return Uint8Array.from(der, (c) => c.charCodeAt(0)).buffer;
  }

  it('opens with the right password, and says so exactly with a wrong one', async () => {
    const file = await p12('correct horse');
    const { certificate } = await loadP12(file, 'correct horse');
    expect(certificate.subject.getField('CN').value).toBe('Ada Lovelace');
    await expect(loadP12(file, 'wrong')).rejects.toThrow(WRONG_CERT_PASSWORD_MESSAGE);
  }, 60_000);

  it('opens the generated .p12, which has no password', async () => {
    const { certificate } = await loadP12(cert.p12Buffer, '');
    expect(certificate.subject.getField('CN').value).toBe('Ada Lovelace');
  }, 60_000);

  it('names a new field after the ones already there', () => {
    expect(uniqueFieldName([])).toBe('Signature1');
    expect(uniqueFieldName(['Signature1', 'Signature2', 'Name'])).toBe('Signature3');
  });
});
