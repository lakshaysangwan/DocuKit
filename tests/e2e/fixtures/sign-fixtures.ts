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
 * it: no `q`/`Q` around a `cm` that halves and shifts everything. Anything
 * appended to the page inherits that transform unless the writer isolates the
 * existing content first — in which case a stamp is drawn at half size, 150pt
 * right and 200pt up from where it was shown.
 */
export async function makeUnbalancedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const content = [
    '0.5 0 0 0.5 150 200 cm',
    '0.85 0.85 0.85 rg',
    '0 0 400 300 re f',
    '0 0 0 RG 2 w',
    '0 0 400 300 re S',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  return doc.save();
}
