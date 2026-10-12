import type { Page } from '@playwright/test';
import { MARKER_COLOURS } from './sign-fixtures';

/**
 * Images for the Image to PDF tests, made in memory.
 *
 * Each one is the four-colour marker from sign-fixtures.ts (a different colour
 * in each quadrant), so a test can find it in a rendered page and say not just
 * "an image is there" but "it is the right way up and its colours survived".
 */

type Rgb = readonly [number, number, number];
type Quadrant = keyof typeof MARKER_COLOURS;

const QUADRANTS: Quadrant[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

function quadrantAt(x: number, y: number, width: number, height: number): Quadrant {
  const top = y < height / 2;
  const left = x < width / 2;
  return top ? (left ? 'topLeft' : 'topRight') : left ? 'bottomLeft' : 'bottomRight';
}

/** A 24-bit BMP of the marker. */
export function makeMarkerBmp(width = 240, height = 160): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    // BMP rows run bottom to top, and each pixel is stored blue, green, red.
    const row = (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = MARKER_COLOURS[quadrantAt(x, y, width, height)];
      pixels.set([b, g, r], row + x * 3);
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10); // where the pixels start
  header.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38); // 72 dpi
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

/**
 * A GIF of the marker. With `transparentQuadrant` that quadrant is see-through
 * instead of coloured.
 *
 * Written without real LZW compression: with a 128-colour table every code is
 * one byte, and a "clear" code often enough keeps it that way.
 */
export function makeMarkerGif(opts: { width?: number; height?: number; transparentQuadrant?: Quadrant } = {}): Buffer {
  const { width = 240, height = 160, transparentQuadrant } = opts;
  const TRANSPARENT = 4;
  const palette = Buffer.alloc(128 * 3);
  QUADRANTS.forEach((q, i) => palette.set(MARKER_COLOURS[q] as Rgb, i * 3));

  const CLEAR = 128;
  const END = 129;
  const codes: number[] = [];
  let sinceClear = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (sinceClear === 0) codes.push(CLEAR);
      const q = quadrantAt(x, y, width, height);
      codes.push(q === transparentQuadrant ? TRANSPARENT : QUADRANTS.indexOf(q));
      sinceClear = (sinceClear + 1) % 100;
    }
  }
  codes.push(END);

  const blocks: Buffer[] = [];
  for (let i = 0; i < codes.length; i += 255) {
    const chunk = codes.slice(i, i + 255);
    blocks.push(Buffer.from([chunk.length, ...chunk]));
  }

  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x80 | 0x70 | 6; // global colour table, 8 bits/channel, 2^(6+1) entries

  const image = Buffer.alloc(10);
  image[0] = 0x2c;
  image.writeUInt16LE(width, 5);
  image.writeUInt16LE(height, 7);

  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    screen,
    palette,
    // Graphic control extension: says which colour index is transparent.
    Buffer.from([0x21, 0xf9, 4, transparentQuadrant ? 1 : 0, 0, 0, TRANSPARENT, 0]),
    image,
    Buffer.from([7]), // minimum code size
    ...blocks,
    Buffer.from([0, 0x3b]),
  ]);
}

/**
 * An EXIF APP1 segment that carries only an Orientation tag, spliced in after
 * the JPEG's start marker.
 */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1'); // big-endian
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 follows the header
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  // bytes 20–21: padding of the value field; 22–25: no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

/**
 * A phone photo taken upright: the marker, 600 × 400 as it should be seen, but
 * stored turned a quarter turn (400 × 600) with EXIF orientation 6 saying
 * "rotate me clockwise to show me". Browsers obey that; PDF readers never see
 * it — which is the bug the test is for.
 *
 * Encoded by the browser under test, since Node has no JPEG encoder here.
 */
export async function makeSidewaysJpeg(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate((colours) => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 600;
    const ctx = canvas.getContext('2d')!;
    const fill = (c: readonly number[], x: number, y: number) => {
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(x, y, 200, 300);
    };
    // Turning the stored picture clockwise moves its bottom-left to the top-left.
    fill(colours.topLeft, 0, 300); // stored bottom-left
    fill(colours.topRight, 0, 0); // stored top-left
    fill(colours.bottomRight, 200, 0); // stored top-right
    fill(colours.bottomLeft, 200, 300); // stored bottom-right
    return canvas.toDataURL('image/jpeg', 0.95);
  }, MARKER_COLOURS);
  return withExifOrientation(Buffer.from(dataUrl.split(',')[1], 'base64'), 6);
}
