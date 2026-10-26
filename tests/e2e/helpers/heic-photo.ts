import { expect } from '@playwright/test';
import { pageImages, renderPage, type Raster, type ViewRect } from './redact-pdf';

/**
 * The checked-in iPhone photo (`FIXTURE.heic`, 600 × 400, HEVC-coded) as it
 * should come out of any tool that puts it into a PDF: one embedded image of
 * that pixel size, drawn landscape, and — on the rendered page — the photo
 * itself rather than a blank or black box.
 *
 * "The photo itself" is checked against a coarse fingerprint: the mean colour
 * of each cell of a 4 × 3 grid over the picture, taken once from the photo as
 * libheif decodes it. A blank, black, sideways or mirrored picture misses it
 * by far more than the tolerance; JPEG re-encoding and the renderer's
 * resampling stay well inside it.
 */
export const HEIC_PHOTO_SIZE: [number, number] = [600, 400];

const COLS = 4;
const ROWS = 3;

/** Mean RGB of each cell of a COLS × ROWS grid over `rect` (fractions of the raster), row by row. */
export function cellMeans(r: Raster, rect: ViewRect = { x: 0, y: 0, width: 1, height: 1 }): [number, number, number][] {
  const cells: [number, number, number][] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      // Inset each cell a little so edge resampling does not count.
      const x0 = Math.floor((rect.x + (rect.width * (col + 0.1)) / COLS) * r.width);
      const x1 = Math.ceil((rect.x + (rect.width * (col + 0.9)) / COLS) * r.width);
      const y0 = Math.floor((rect.y + (rect.height * (row + 0.1)) / ROWS) * r.height);
      const y1 = Math.ceil((rect.y + (rect.height * (row + 0.9)) / ROWS) * r.height);
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * r.width + x) * 3;
          sum[0] += r.data[i];
          sum[1] += r.data[i + 1];
          sum[2] += r.data[i + 2];
          n++;
        }
      }
      cells.push([sum[0] / n, sum[1] / n, sum[2] / n]);
    }
  }
  return cells;
}

/**
 * The photo's fingerprint (see above), from libheif's decode of FIXTURE.heic:
 * a blue-to-purple gradient from the top left to the bottom right, with
 * "TEST" in white across the middle. Turned or mirrored, the green channel
 * alone is off by 29–89 in some cells.
 */
export const HEIC_PHOTO_CELLS: [number, number, number][] = [
  [82, 120, 206], [84, 101, 195], [94, 79, 182], [103, 53, 171],
  [80, 110, 199], [105, 103, 194], [113, 79, 181], [111, 39, 163],
  [86, 96, 193], [95, 72, 181], [105, 49, 169], [117, 31, 154],
];

/** How far any cell's channel mean may be from the fingerprint. */
const CELL_TOLERANCE = 16;

export function expectCellsMatch(actual: [number, number, number][], what: string) {
  expect(actual).toHaveLength(HEIC_PHOTO_CELLS.length);
  actual.forEach((cell, i) => {
    cell.forEach((v, c) => {
      expect(
        Math.abs(v - HEIC_PHOTO_CELLS[i][c]),
        `${what}: cell ${i} channel ${'RGB'[c]} is ${v.toFixed(0)}, the photo has ${HEIC_PHOTO_CELLS[i][c]}`,
      ).toBeLessThanOrEqual(CELL_TOLERANCE);
    });
  });
}

/**
 * Assert page `pageIndex` of `pdf` carries the HEIC photo: exactly one image,
 * 600 × 400 pixels, drawn landscape, and the rendered page shows the photo
 * where it is drawn. Returns where it is drawn, as fractions of the page.
 */
export async function expectHeicPhotoOnPage(pdf: Buffer, pageIndex = 0): Promise<ViewRect> {
  const images = await pageImages(pdf, pageIndex);
  expect(images, 'one image on the page').toHaveLength(1);
  const [{ bbox, raster }] = images;
  expect([raster.width, raster.height], 'the embedded image is the photo’s pixel size').toEqual(HEIC_PHOTO_SIZE);
  expectCellsMatch(cellMeans(raster), 'embedded image');

  const rendered = await renderPage(pdf, pageIndex, 2);
  // Drawn upright: the box on the page has the photo's landscape proportions.
  const shown = (bbox.width * rendered.width) / (bbox.height * rendered.height);
  expect(shown, 'drawn landscape, 3:2').toBeCloseTo(HEIC_PHOTO_SIZE[0] / HEIC_PHOTO_SIZE[1], 1);
  expectCellsMatch(cellMeans(rendered, bbox), 'rendered page');
  return bbox;
}
