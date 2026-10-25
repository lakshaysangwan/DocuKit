/**
 * Fixtures for "the stamp lands where it was shown".
 *
 * Place-on-page tools used to write raw user-space coordinates and assume a
 * page that starts at 0,0 and is not rotated. These are the pages that break
 * that assumption, plus an image whose four corners can be told apart, so a
 * test can see not only where a stamp landed but which way up.
 */
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import { deflateSync, crc32 } from 'node:zlib';

type Rgb = [number, number, number];

/**
 * The marker's quadrant colours: top-left, top-right, bottom-left, bottom-right.
 * None of them appears in any fixture page, so finding one in a rendered page
 * means finding the marker.
 */
export const MARKER_COLOURS = {
  topLeft: [230, 0, 160],
  topRight: [0, 170, 200],
  bottomLeft: [245, 130, 0],
  bottomRight: [60, 190, 40],
} as const satisfies Record<string, Rgb>;

/** Marker image size in pixels (3:1, about the shape of a signature). */
export const MARKER_SIZE = { width: 240, height: 80 } as const;

/** An opaque PNG whose quadrants are the four `MARKER_COLOURS`. */
export function makeMarkerPng(): Buffer {
  const { width, height } = MARKER_SIZE;
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const top = y < height / 2;
      const left = x < width / 2;
      const colour = top
        ? left ? MARKER_COLOURS.topLeft : MARKER_COLOURS.topRight
        : left ? MARKER_COLOURS.bottomLeft : MARKER_COLOURS.bottomRight;
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
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Two Letter pages stored upright but displayed turned 90° clockwise
 * (`/Rotate 90`), as most scanners produce. The text is drawn so it reads the
 * right way up once the page is turned.
 */
export async function makeRotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(90));
    // Displayed size is 792 × 612. Text along the displayed top edge runs up
    // the stored page's left side.
    page.drawText(`Rotated scan, page ${i + 1}`, { x: 60, y: 60, size: 24, font, rotate: degrees(90), color: rgb(0, 0, 0) });
    page.drawText('Sign here:', { x: 500, y: 300, size: 14, font, rotate: degrees(90), color: rgb(0.2, 0.2, 0.2) });
    page.drawLine({ start: { x: 520, y: 300 }, end: { x: 520, y: 600 }, thickness: 1, color: rgb(0.3, 0.3, 0.3) });
  }
  return doc.save();
}

/**
 * A page whose visible area does not start at the origin: the MediaBox is
 * Letter but a CropBox cuts 50pt off the left and right and 100pt and 50pt off
 * the bottom and top, as "Crop PDF" (in CropBox mode) leaves it. A stamp
 * written with raw coordinates lands 50pt left and 100pt below where it was shown.
 */
export async function makeCropOffsetPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.setCropBox(50, 100, 512, 642);
  page.drawText('Cropped page', { x: 90, y: 680, size: 24, font, color: rgb(0, 0, 0) });
  page.drawText('Only the middle of the sheet is visible.', { x: 90, y: 650, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
  page.drawRectangle({ x: 50, y: 100, width: 512, height: 642, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
  return doc.save();
}

/**
 * A page whose content stream changes the coordinate system and never restores
 * it: it saves the graphics state twice (`q`), scaling and shifting each time,
 * and closes neither. pdf-lib's own `q … Q` around existing content undoes only
 * the innermost, so a stamp appended naively is drawn at half size, 150pt right
 * and 200pt up from where it was shown. The writer has to close the states the
 * page left open first.
 */
export async function makeUnbalancedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const content = [
    'q',
    '0.5 0 0 0.5 150 200 cm',
    'q',
    '0.5 0 0 0.5 0 0 cm',
    '0.85 0.85 0.85 rg',
    '0 0 400 300 re f',
    '0 0 0 RG 2 w',
    '0 0 400 300 re S',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  return doc.save();
}

/**
 * "A photo of a signature": off-white, yellowish paper lit unevenly (a good
 * deal darker toward the bottom right), with sensor noise; a blue-ink
 * signature stroke and the dot of an "i"; and a few dark specks well away from
 * the ink. Saved as a JPEG, as a phone saves it. Drawn by a browser canvas
 * during global setup, from a seeded random source, so it is the same file on
 * every run.
 */
export const SIGNATURE_PHOTO = {
  width: 1600,
  height: 1200,
  ink: [25, 45, 160] as Rgb,
  /** Pen width in pixels (round caps and joins). */
  pen: 12,
  /** The stroke, as a polyline. */
  stroke: Array.from({ length: 61 }, (_, k): [number, number] => {
    const x = 420 + k * 13;
    return [x, Math.round(640 + 90 * Math.sin(k / 5) - 40 * Math.sin(k / 2.2))];
  }),
  /** The dot over an "i": centre and radius. */
  dot: { x: 900, y: 430, r: 9 },
  /** Dark specks (dust, noise), each a few pixels across. */
  specks: [
    [120, 140],
    [1480, 180],
    [200, 1050],
    [1450, 1080],
    [800, 1120],
    [80, 600],
  ] as [number, number][],
} as const;

/** The ink's own bounding box in the photo, in pixels (edges inclusive). */
export function signaturePhotoInkBox() {
  const { stroke, pen, dot } = SIGNATURE_PHOTO;
  const xs = stroke.map((p) => p[0]);
  const ys = stroke.map((p) => p[1]);
  const half = pen / 2;
  return {
    x0: Math.min(...xs) - half,
    x1: Math.max(...xs) + half,
    y0: Math.min(dot.y - dot.r, Math.min(...ys) - half),
    y1: Math.max(...ys) + half,
  };
}

/** Browser script (a string, so no bundler helpers leak into it) that returns the photo as base-64 JPEG. */
export function signaturePhotoScript(): string {
  return `(async () => {
    const P = ${JSON.stringify(SIGNATURE_PHOTO)};
    let seed = 20261025;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const c = document.createElement('canvas');
    c.width = P.width; c.height = P.height;
    const ctx = c.getContext('2d');
    // Paper, lit from the top left.
    const img = ctx.createImageData(P.width, P.height);
    for (let y = 0; y < P.height; y++) {
      for (let x = 0; x < P.width; x++) {
        const light = 1 - 0.32 * ((x / P.width) * 0.6 + (y / P.height) * 0.4);
        const n = (random() - 0.5) * 12;
        const i = (y * P.width + x) * 4;
        img.data[i] = 246 * light + n;
        img.data[i + 1] = 238 * light + n;
        img.data[i + 2] = 206 * light + n;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // The ink, a little darker where the light is.
    const g = ctx.createLinearGradient(0, 0, P.width, P.height);
    g.addColorStop(0, 'rgb(' + P.ink.join(',') + ')');
    g.addColorStop(1, 'rgb(' + P.ink.map((v) => Math.round(v * 0.75)).join(',') + ')');
    ctx.strokeStyle = g;
    ctx.fillStyle = g;
    ctx.lineWidth = P.pen;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    P.stroke.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(P.dot.x, P.dot.y, P.dot.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgb(60,55,50)';
    for (const [x, y] of P.specks) {
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + random() * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const blob = await new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  })()`;
}

/**
 * Four pages that are not alike, for "put the signature on every page": a
 * Letter portrait page, a landscape page, a Letter page stored upright but
 * displayed turned (`/Rotate 90`), and an A5 page whose CropBox does not start
 * at the origin. Displayed sizes: 612×792, 792×612, 792×612, 380×535.
 */
export const MIXED_PAGES = [
  { widthPt: 612, heightPt: 792 },
  { widthPt: 792, heightPt: 612 },
  { widthPt: 792, heightPt: 612 },
  { widthPt: 380, heightPt: 535 },
] as const;

export async function makeMixedPagesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const portrait = doc.addPage([612, 792]);
  portrait.drawText('Mixed page 1: Letter portrait', { x: 60, y: 720, size: 20, font, color: rgb(0, 0, 0) });

  const landscape = doc.addPage([792, 612]);
  landscape.drawText('Mixed page 2: landscape', { x: 60, y: 540, size: 20, font, color: rgb(0, 0, 0) });

  const rotated = doc.addPage([612, 792]);
  rotated.setRotation(degrees(90));
  rotated.drawText('Mixed page 3: /Rotate 90', { x: 60, y: 60, size: 20, font, rotate: degrees(90), color: rgb(0, 0, 0) });

  const a5 = doc.addPage([420, 595]);
  a5.setCropBox(20, 30, 380, 535);
  a5.drawText('Mixed page 4: A5, cropped', { x: 40, y: 520, size: 16, font, color: rgb(0, 0, 0) });
  a5.drawRectangle({ x: 20, y: 30, width: 380, height: 535, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
  return doc.save();
}
