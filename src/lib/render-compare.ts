/**
 * Has a page come out grossly different after compression?
 *
 * Both renders — the original page and the same page of the real output, drawn
 * by pdf.js — are reduced to a coarse grid of mean brightness, and the grids are
 * compared. JPEG softening and downscaling move single pixels but barely move
 * the average of a cell; a page that came out black, inverted, sheared or with
 * a lost mask moves whole cells a long way. That difference is what is flagged.
 *
 * It cannot see damage smaller than a cell, nor a page pdf.js draws wrongly on
 * both sides. It is a guard against the gross failures, not a quality score.
 *
 * Pure: works on anything shaped like `ImageData`, so it is unit-tested in Node.
 */

/** Cells per side of the brightness grid. */
export const GRID_SIZE = 32;

/** A cell has "changed" when its mean brightness moved by more than this (0–255). */
export const CELL_CHANGE_THRESHOLD = 40;

/**
 * Suspect when more than this share of the cells changed. 0.1 is a tenth of
 * the page: far beyond what even the harshest compression step does to a cell's
 * average, and well short of a half-black or partly-inverted page.
 */
export const SUSPECT_CHANGED_SHARE = 0.1;

/** Suspect when the mean change over all cells is above this (0–255). */
export const SUSPECT_MEAN_DIFF = 20;

/** Below this mean change the page counts as unchanged. */
export const SAME_MEAN_DIFF = 0.5;

export type CompareVerdict = 'same' | 'changed' | 'suspect';

export interface GridComparison {
  /** Mean absolute difference between the grids, 0–255. */
  meanAbsDiff: number;
  /** Share of cells (0–1) whose brightness moved by more than `CELL_CHANGE_THRESHOLD`. */
  changedCellShare: number;
  verdict: CompareVerdict;
}

/** What `lumaGrid` reads: `ImageData`, or the same shape. */
export interface PixelsLike {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: ArrayLike<number>;
}

/**
 * Mean brightness (Rec. 601 luma, 0–255) of each cell of an `n × n` grid laid
 * over the image. Every pixel lands in exactly one cell, so images of
 * different sizes but the same picture give nearly the same grid. Transparent
 * pixels are taken as drawn on white, as a page is.
 */
export function lumaGrid(image: PixelsLike, n: number = GRID_SIZE): Float32Array {
  const { width, height, data } = image;
  const sums = new Float64Array(n * n);
  const counts = new Uint32Array(n * n);
  for (let y = 0; y < height; y++) {
    const row = Math.min(n - 1, Math.floor((y * n) / height));
    for (let x = 0; x < width; x++) {
      const col = Math.min(n - 1, Math.floor((x * n) / width));
      const i = (y * width + x) * 4;
      const alpha = data[i + 3] / 255;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const cell = row * n + col;
      sums[cell] += luma * alpha + 255 * (1 - alpha);
      counts[cell]++;
    }
  }
  const grid = new Float32Array(n * n);
  for (let c = 0; c < grid.length; c++) grid[c] = counts[c] ? sums[c] / counts[c] : 255;
  return grid;
}

/** Compare two grids of the same size. */
export function compareGrids(a: Float32Array, b: Float32Array): GridComparison {
  if (a.length !== b.length || a.length === 0) throw new RangeError('The grids must be the same, non-zero size.');
  let total = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i] - b[i]);
    total += diff;
    if (diff > CELL_CHANGE_THRESHOLD) changed++;
  }
  const meanAbsDiff = total / a.length;
  const changedCellShare = changed / a.length;
  const verdict: CompareVerdict =
    meanAbsDiff > SUSPECT_MEAN_DIFF || changedCellShare > SUSPECT_CHANGED_SHARE
      ? 'suspect'
      : meanAbsDiff < SAME_MEAN_DIFF
        ? 'same'
        : 'changed';
  return { meanAbsDiff, changedCellShare, verdict };
}

/** Convenience: grid both images and compare them. */
export function compareRenders(before: PixelsLike, after: PixelsLike, n: number = GRID_SIZE): GridComparison {
  return compareGrids(lumaGrid(before, n), lumaGrid(after, n));
}
