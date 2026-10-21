import { describe, it, expect } from 'vitest';
import {
  compareGrids,
  compareRenders,
  lumaGrid,
  GRID_SIZE,
  SUSPECT_CHANGED_SHARE,
  SUSPECT_MEAN_DIFF,
  type PixelsLike,
} from './render-compare';

const W = 240;
const H = 310;

/** A deterministic pseudo-random sequence, so the tests do not flake. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Something page-like: white paper, a smooth "photo" in the top half, dark
 * lines of "text" below it.
 */
function page(): PixelsLike {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r = 255;
      let g = 255;
      let b = 255;
      if (y > 20 && y < 150 && x > 20 && x < 220) {
        r = 120 + 100 * Math.sin(x / 17);
        g = 90 + 80 * Math.cos(y / 23);
        b = 60 + 60 * Math.sin((x + y) / 31);
      } else if (y > 170 && y < 290 && x > 20 && x < 220 && y % 12 < 4 && (x * 7) % 19 < 13) {
        r = g = b = 20;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function map(src: PixelsLike, f: (rgb: [number, number, number], x: number, y: number) => [number, number, number]): PixelsLike {
  const data = new Uint8ClampedArray(src.data.length);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      const [r, g, b] = f([src.data[i], src.data[i + 1], src.data[i + 2]], x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: src.width, height: src.height, data };
}

/** What heavy JPEG does: per-pixel noise plus 8×8 blocks flattened towards their mean. */
function jpegLike(src: PixelsLike, noise: number, seed = 1): PixelsLike {
  const rand = rng(seed);
  const block = (x: number, y: number, c: number) => {
    const bx = Math.floor(x / 8) * 8;
    const by = Math.floor(y / 8) * 8;
    let sum = 0;
    let n = 0;
    for (let yy = by; yy < Math.min(by + 8, src.height); yy++) {
      for (let xx = bx; xx < Math.min(bx + 8, src.width); xx++) {
        sum += src.data[(yy * src.width + xx) * 4 + c];
        n++;
      }
    }
    return sum / n;
  };
  return map(src, ([r, g, b], x, y) => {
    const jitter = () => (rand() - 0.5) * 2 * noise;
    return [
      (r + block(x, y, 0)) / 2 + jitter(),
      (g + block(x, y, 1)) / 2 + jitter(),
      (b + block(x, y, 2)) / 2 + jitter(),
    ];
  });
}

/** Downscale by `factor` and back up with nearest neighbour — the harshest target step uses 0.25. */
function resampled(src: PixelsLike, factor: number): PixelsLike {
  const step = Math.round(1 / factor);
  return map(src, (_rgb, x, y) => {
    const sx = Math.min(src.width - 1, Math.floor(x / step) * step);
    const sy = Math.min(src.height - 1, Math.floor(y / step) * step);
    const i = (sy * src.width + sx) * 4;
    return [src.data[i], src.data[i + 1], src.data[i + 2]];
  });
}

describe('lumaGrid', () => {
  it('is the mean brightness of each cell', () => {
    const white = map(page(), () => [255, 255, 255]);
    const grid = lumaGrid(white, 4);
    expect(grid).toHaveLength(16);
    for (const v of grid) expect(v).toBeCloseTo(255, 3);
    const black = lumaGrid(map(page(), () => [0, 0, 0]), 4);
    for (const v of black) expect(v).toBe(0);
  });

  it('reads transparent pixels as paper', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4); // all zero: transparent black
    for (const v of lumaGrid({ width: 4, height: 4, data }, 2)) expect(v).toBe(255);
  });

  it('gives nearly the same grid for the same picture at another size', () => {
    const big = page();
    const small = { width: W / 2, height: Math.floor(H / 2), data: new Uint8ClampedArray((W / 2) * Math.floor(H / 2) * 4) };
    for (let y = 0; y < small.height; y++) {
      for (let x = 0; x < small.width; x++) {
        const s = (y * 2 * W + x * 2) * 4;
        const d = (y * small.width + x) * 4;
        for (let c = 0; c < 4; c++) small.data[d + c] = big.data[s + c];
      }
    }
    expect(compareRenders(big, small).verdict).not.toBe('suspect');
  });
});

describe('compareGrids', () => {
  const original = page();

  it('identical renders are the same', () => {
    const result = compareRenders(original, page());
    expect(result).toEqual({ meanAbsDiff: 0, changedCellShare: 0, verdict: 'same' });
  });

  it('JPEG-like noise and blocking is a change, not a suspect page', () => {
    for (const noise of [4, 12, 24]) {
      const result = compareRenders(original, jpegLike(original, noise, noise));
      expect(result.verdict, `noise ±${noise}`).toBe('changed');
      expect(result.changedCellShare).toBeLessThan(SUSPECT_CHANGED_SHARE / 2);
      expect(result.meanAbsDiff).toBeLessThan(SUSPECT_MEAN_DIFF / 2);
    }
  });

  it('downsampling to a quarter of the width and height is not suspect', () => {
    const result = compareRenders(original, jpegLike(resampled(original, 0.25), 12));
    expect(result.verdict).toBe('changed');
  });

  it('a black page is suspect', () => {
    const result = compareRenders(original, map(original, () => [0, 0, 0]));
    expect(result.verdict).toBe('suspect');
    expect(result.meanAbsDiff).toBeGreaterThan(100);
  });

  it('an inverted page is suspect', () => {
    const result = compareRenders(original, map(original, ([r, g, b]) => [255 - r, 255 - g, 255 - b]));
    expect(result.verdict).toBe('suspect');
    expect(result.changedCellShare).toBeGreaterThan(0.5);
  });

  it('a page black in its lower half is suspect', () => {
    const result = compareRenders(original, map(original, (rgb, _x, y) => (y >= H / 2 ? [0, 0, 0] : rgb)));
    expect(result.verdict).toBe('suspect');
    expect(result.changedCellShare).toBeGreaterThan(0.3);
  });

  it('only a picture turned black is suspect too (a lost mask)', () => {
    // The photo area is about a third of the page.
    const result = compareRenders(original, map(original, (rgb, x, y) => (y > 20 && y < 150 && x > 20 && x < 220 ? [0, 0, 0] : rgb)));
    expect(result.verdict).toBe('suspect');
  });

  it('refuses grids of different sizes', () => {
    expect(() => compareGrids(new Float32Array(4), new Float32Array(GRID_SIZE * GRID_SIZE))).toThrow(RangeError);
  });
});
