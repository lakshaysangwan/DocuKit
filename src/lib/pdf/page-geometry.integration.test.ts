/**
 * Geometry against real PDFs and real renderers.
 *
 * For each awkward kind of page — /Rotate 0/90/180/270, a CropBox that does not
 * start at the origin, a MediaBox that does not either, UserUnit ≠ 1 — this:
 *
 *   1. builds the page with pdf-lib;
 *   2. reads its box, rotation and UserUnit with pdf.js, exactly as
 *      `PdfDocHandle.geometry()` does, and checks the mapping agrees with the
 *      pdf.js viewport (`convertToPdfPoint`), which is what draws the preview;
 *   3. draws a four-coloured image with pdf-lib at the parameters
 *      `viewRectToPdfDraw` returns for a known rectangle of the displayed page,
 *      once upright and once turned 30° clockwise;
 *   4. renders the result with MuPDF — a second, independent renderer — and
 *      looks for each of the four colours where the view rectangle says that
 *      corner of the image should be.
 *
 * Step 4 is what a unit test cannot give: it fails if the image is in the wrong
 * place, turned the wrong way, mirrored, or the wrong size, in the actual file.
 */
import { describe, it, expect } from 'vitest';
import { deflateSync, crc32 } from 'node:zlib';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import {
  makePageGeometry,
  viewPointToPdf,
  viewRectToPdfDraw,
  viewMarginsToCropBox,
  type PageGeometry,
  type RectNorm,
} from './page-geometry';

type Rgb = [number, number, number];
const RED: Rgb = [220, 30, 30];
const GREEN: Rgb = [30, 170, 60];
const BLUE: Rgb = [40, 60, 220];
const YELLOW: Rgb = [240, 220, 40];
const WHITE: Rgb = [255, 255, 255];

/** A PNG whose quadrants are red (top-left), green (top-right), blue (bottom-left), yellow (bottom-right). */
function quadrantPng(size = 64): Uint8Array {
  const row = size * 3 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const colour = y < size / 2 ? (x < size / 2 ? RED : GREEN) : x < size / 2 ? BLUE : YELLOW;
      raw.set(colour, y * row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface PageSpec {
  name: string;
  rotate: 0 | 90 | 180 | 270;
  /** MediaBox as [x, y, width, height]. */
  media: [number, number, number, number];
  /** CropBox as [x, y, width, height], when the page has one. */
  crop?: [number, number, number, number];
  userUnit?: number;
}

const ROTATIONS = [0, 90, 180, 270] as const;
const SPECS: PageSpec[] = [
  ...ROTATIONS.map((rotate): PageSpec => ({ name: `/Rotate ${rotate}`, rotate, media: [0, 0, 400, 600] })),
  ...ROTATIONS.map((rotate): PageSpec => ({
    name: `/Rotate ${rotate} with an offset CropBox`, rotate, media: [0, 0, 400, 600], crop: [40, 70, 300, 420],
  })),
  ...ROTATIONS.map((rotate): PageSpec => ({
    name: `/Rotate ${rotate} with a MediaBox off the origin`, rotate, media: [-30, 25, 400, 600],
  })),
  ...ROTATIONS.map((rotate): PageSpec => ({
    name: `/Rotate ${rotate} with UserUnit 2 and an offset CropBox`,
    rotate, media: [0, 0, 400, 600], crop: [40, 70, 300, 420], userUnit: 2,
  })),
];

/** Where the two test images go on the displayed page, and how far each is turned. */
const UPRIGHT: RectNorm = { x: 0.1, y: 0.08, width: 0.34, height: 0.2 };
const TURNED: RectNorm = { x: 0.5, y: 0.56, width: 0.34, height: 0.2 };
const TURN_DEG = 30;

async function buildPage(spec: PageSpec): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([spec.media[2], spec.media[3]]);
  page.setMediaBox(...spec.media);
  if (spec.crop) page.setCropBox(...spec.crop);
  if (spec.rotate) page.setRotation(degrees(spec.rotate));
  if (spec.userUnit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(spec.userUnit));
  // A faint fill over the whole MediaBox, so "outside the image" has a known colour.
  page.drawRectangle({ x: spec.media[0], y: spec.media[1], width: spec.media[2], height: spec.media[3], color: rgb(1, 1, 1) });
  return doc;
}

/** Geometry the way the handle reads it, plus the pdf.js viewport to compare with. */
async function readWithPdfjs(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(1);
    const geom = makePageGeometry({ view: page.view, rotate: page.rotate, userUnit: page.userUnit });
    const viewport = page.getViewport({ scale: 1 });
    const probes = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.2, 0.7], [0.85, 0.15]].map(([u, v]) => ({
      u, v, pdf: viewport.convertToPdfPoint(u * viewport.width, v * viewport.height) as number[],
    }));
    return { geom, viewportSize: [viewport.width, viewport.height], probes };
  } finally {
    await doc.destroy();
  }
}

/** Render page 1 with MuPDF; returns a sampler taking fractions of the displayed page. */
async function renderWithMupdf(bytes: Uint8Array, pixelsPerPoint = 2) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const page = doc.loadPage(0);
    const pix = page.toPixmap(mupdf.Matrix.scale(pixelsPerPoint, pixelsPerPoint), mupdf.ColorSpace.DeviceRGB, false);
    const width = pix.getWidth(), height = pix.getHeight(), stride = pix.getStride(), n = pix.getNumberOfComponents();
    const pixels = pix.getPixels().slice();
    return {
      width, height,
      at(u: number, v: number): Rgb {
        const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
        const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
        const o = y * stride + x * n;
        return [pixels[o], pixels[o + 1], pixels[o + 2]];
      },
    };
  } finally {
    doc.destroy();
  }
}

/** A point of an <img> at `rect`, turned clockwise by θ about its centre; (s, t) from its top-left. */
function imagePointInView(geom: PageGeometry, rect: RectNorm, thetaCw: number, s: number, t: number): [number, number] {
  const w = rect.width * geom.widthPt, h = rect.height * geom.heightPt;
  const cx = (rect.x + rect.width / 2) * geom.widthPt, cy = (rect.y + rect.height / 2) * geom.heightPt;
  const dx = (s - 0.5) * w, dy = (t - 0.5) * h;
  const a = (thetaCw * Math.PI) / 180;
  return [
    (cx + dx * Math.cos(a) - dy * Math.sin(a)) / geom.widthPt,
    (cy + dx * Math.sin(a) + dy * Math.cos(a)) / geom.heightPt,
  ];
}

const near = (actual: Rgb, wanted: Rgb) => actual.every((c, i) => Math.abs(c - wanted[i]) <= 40);

describe.each(SPECS)('real PDF: $name', (spec) => {
  it('matches the pdf.js viewport, and an image drawn from a view rectangle renders where the view says', async () => {
    // Read from one copy, draw on another: pdf-lib freezes a page's content
    // stream the first time the document is saved.
    const { geom, viewportSize, probes } = await readWithPdfjs(await (await buildPage(spec)).save());
    const doc = await buildPage(spec);

    // ── Agreement with pdf.js ──────────────────────────────────────────────
    expect(geom.rotate).toBe(spec.rotate);
    expect(geom.userUnit).toBe(spec.userUnit ?? 1);
    expect(geom.widthPt).toBeCloseTo(viewportSize[0], 6);
    expect(geom.heightPt).toBeCloseTo(viewportSize[1], 6);
    const box = spec.crop ?? spec.media;
    expect([...geom.viewBox]).toEqual([box[0], box[1], box[0] + box[2], box[1] + box[3]]);
    for (const probe of probes) {
      const [x, y] = viewPointToPdf(geom, probe.u, probe.v);
      expect(x).toBeCloseTo(probe.pdf[0], 6);
      expect(y).toBeCloseTo(probe.pdf[1], 6);
    }

    // ── Draw with pdf-lib at what the geometry returns ─────────────────────
    const image = await doc.embedPng(quadrantPng());
    const page = doc.getPage(0);
    for (const [rect, theta] of [[UPRIGHT, 0], [TURNED, TURN_DEG]] as const) {
      const { x, y, width, height, rotateDeg } = viewRectToPdfDraw(geom, rect, theta);
      page.drawImage(image, { x, y, width, height, rotate: degrees(rotateDeg) });
    }

    // ── Render with MuPDF and look for the colours ─────────────────────────
    const render = await renderWithMupdf(await doc.save());
    // MuPDF shows the same page box, turned and scaled by UserUnit the same way.
    expect(render.width / render.height).toBeCloseTo(geom.widthPt / geom.heightPt, 2);
    expect(render.width).toBeCloseTo(geom.widthPt * 2, -1);

    const quadrants: Array<[number, number, Rgb, string]> = [
      [0.25, 0.25, RED, 'top-left'],
      [0.75, 0.25, GREEN, 'top-right'],
      [0.25, 0.75, BLUE, 'bottom-left'],
      [0.75, 0.75, YELLOW, 'bottom-right'],
    ];
    for (const [rect, theta] of [[UPRIGHT, 0], [TURNED, TURN_DEG]] as const) {
      for (const [s, t, colour, corner] of quadrants) {
        const [u, v] = imagePointInView(geom, rect, theta, s, t);
        const seen = render.at(u, v);
        expect(near(seen, colour), `${corner} quadrant of the image turned ${theta}°: saw rgb(${seen})`).toBe(true);
      }
      // Just outside each edge of the image there is only page.
      for (const [s, t] of [[-0.08, 0.5], [1.08, 0.5], [0.5, -0.12], [0.5, 1.12]]) {
        const [u, v] = imagePointInView(geom, rect, theta, s, t);
        expect(near(render.at(u, v), WHITE), `outside the image turned ${theta}° at ${s},${t}`).toBe(true);
      }
    }
  });

  it('a crop box built from view margins shows exactly the part of the page inside them', async () => {
    const { geom } = await readWithPdfjs(await (await buildPage(spec)).save());
    const doc = await buildPage(spec);
    const page = doc.getPage(0);

    // A marker in the top-left of the displayed page, and margins that keep
    // only the region around it: after cropping, the marker fills a known part
    // of what is left.
    const marker: RectNorm = { x: 0.2, y: 0.1, width: 0.2, height: 0.2 };
    const image = await doc.embedPng(quadrantPng());
    const draw = viewRectToPdfDraw(geom, marker);
    page.drawImage(image, { x: draw.x, y: draw.y, width: draw.width, height: draw.height, rotate: degrees(draw.rotateDeg) });

    const margins = { top: 0.05, left: 0.1, right: 0.5, bottom: 0.65 };
    page.setCropBox(...viewMarginsToCropBox(geom, margins));

    const render = await renderWithMupdf(await doc.save());
    const keptWidth = 1 - margins.left - margins.right;
    const keptHeight = 1 - margins.top - margins.bottom;
    expect(render.width / render.height).toBeCloseTo((keptWidth * geom.widthPt) / (keptHeight * geom.heightPt), 1);

    // The marker's quadrant centres, re-expressed as fractions of the cropped page.
    const inCrop = (u: number, v: number): [number, number] => [(u - margins.left) / keptWidth, (v - margins.top) / keptHeight];
    for (const [s, t, colour] of [[0.25, 0.25, RED], [0.75, 0.25, GREEN], [0.25, 0.75, BLUE], [0.75, 0.75, YELLOW]] as const) {
      const [u, v] = inCrop(marker.x + s * marker.width, marker.y + t * marker.height);
      const seen = render.at(u, v);
      expect(near(seen, colour as Rgb), `saw rgb(${seen}) at ${u.toFixed(2)},${v.toFixed(2)}`).toBe(true);
    }
  });
});
