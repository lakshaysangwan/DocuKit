import { describe, it, expect } from 'vitest';
import { extractInk, prepareSignature, thresholdFor, workingScale, type RgbaImage } from './signature-extract';

/** A seeded random source, so every run draws the same "photo". */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Rgb = [number, number, number];

interface Photo {
  img: RgbaImage;
  /** The ink's own bounding box (stroke and dot, edge pixels included). */
  inkBox: { x0: number; y0: number; x1: number; y1: number };
  strokeCentres: [number, number][];
  dot: [number, number];
  specks: [number, number][];
}

const dist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * Yellowish paper, lit unevenly (bright top-left, a good deal darker
 * bottom-right), with sensor noise; a wavy signature stroke and the dot of an
 * "i" in `ink`; and a few dark specks away from the signature.
 */
function photo({ ink = [30, 50, 170] as Rgb, width = 600, height = 400, pen = 6, seed = 7 } = {}): Photo {
  const random = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const path: [number, number][] = [];
  for (let k = 0; k <= 40; k++) {
    const x = 120 + k * 9;
    path.push([x, 220 + 45 * Math.sin(k / 4)]);
  }
  const dot: [number, number] = [300, 120];
  const specks: [number, number][] = [
    [40, 40],
    [560, 60],
    [50, 360],
    [570, 370],
  ];
  const half = pen / 2;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = 1 - 0.3 * ((x / width + y / height) / 2);
      const noise = (random() - 0.5) * 10;
      const paper: Rgb = [248 * light + noise, 240 * light + noise, 205 * light + noise];
      let d = Infinity;
      for (let k = 1; k < path.length; k++) d = Math.min(d, dist(x, y, ...path[k - 1], ...path[k]));
      d = Math.min(d, Math.hypot(x - dot[0], y - dot[1]) - half * 0.6);
      // Antialiased pen: full ink inside, a one-pixel ramp at the edge.
      const cover = Math.max(0, Math.min(1, half + 0.5 - d));
      if (cover > 0) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = paper[c] * (1 - cover) + ink[c] * light * cover;
      data[i + 3] = 255;
    }
  }
  for (const [sx, sy] of specks) {
    const i = (sy * width + sx) * 4;
    data[i] = data[i + 1] = data[i + 2] = 40;
  }
  return { img: { data, width, height }, inkBox: { x0, y0, x1, y1 }, strokeCentres: path, dot, specks };
}

const at = (img: RgbaImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

describe('signature extraction', () => {
  const p = photo();
  const prep = prepareSignature(p.img);
  const out = extractInk(prep)!;

  it('crops to the ink, with a small margin, not to the photo', () => {
    expect(out).not.toBeNull();
    const { box } = out;
    expect(Math.abs(box.x - p.inkBox.x0)).toBeLessThanOrEqual(6);
    expect(Math.abs(box.y - p.inkBox.y0)).toBeLessThanOrEqual(6);
    expect(Math.abs(box.x + box.width - 1 - p.inkBox.x1)).toBeLessThanOrEqual(6);
    expect(Math.abs(box.y + box.height - 1 - p.inkBox.y1)).toBeLessThanOrEqual(6);
  });

  it('makes the paper transparent, even where the light falls off', () => {
    const { image } = out;
    for (const [x, y] of [
      [0, 0],
      [image.width - 1, 0],
      [0, image.height - 1],
      [image.width - 1, image.height - 1],
    ]) {
      expect(at(image, x, y)[3]).toBe(0);
    }
    let paperOpaque = 0;
    let paper = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const gx = x + out.box.x;
        const gy = y + out.box.y;
        let d = Infinity;
        for (let k = 1; k < p.strokeCentres.length; k++) d = Math.min(d, dist(gx, gy, ...p.strokeCentres[k - 1], ...p.strokeCentres[k]));
        d = Math.min(d, Math.hypot(gx - p.dot[0], gy - p.dot[1]));
        if (d < 8) continue;
        paper++;
        if (at(image, x, y)[3] > 0) paperOpaque++;
      }
    }
    expect(paper).toBeGreaterThan(10_000);
    expect(paperOpaque).toBe(0);
  });

  it('keeps the strokes opaque and in their own blue', () => {
    for (const [cx, cy] of p.strokeCentres) {
      const [r, g, b, a] = at(out.image, Math.round(cx) - out.box.x, Math.round(cy) - out.box.y);
      expect(a).toBe(255);
      expect(b).toBeGreaterThan(r + 60);
      expect(b).toBeGreaterThan(g + 40);
    }
  });

  it('keeps the dot of an i, and drops the specks', () => {
    expect(at(out.image, p.dot[0] - out.box.x, p.dot[1] - out.box.y)[3]).toBe(255);
    // The specks are outside the crop: they did not widen it.
    for (const [sx, sy] of p.specks) {
      const inside = sx >= out.box.x && sx < out.box.x + out.box.width && sy >= out.box.y && sy < out.box.y + out.box.height;
      expect(inside).toBe(false);
    }
  });

  it('gives stroke edges a soft ramp, not a jagged cut', () => {
    const levels = new Set<number>();
    for (let i = 3; i < out.image.data.length; i += 4) {
      const a = out.image.data[i];
      if (a > 0 && a < 255) levels.add(a);
    }
    expect(levels.size).toBeGreaterThan(20);
  });

  it('"Make ink black" draws every ink pixel black, with the same alpha', () => {
    const black = extractInk(prep, { black: true })!;
    expect(black.box).toEqual(out.box);
    for (let i = 0; i < black.image.data.length; i += 4) {
      expect(black.image.data[i + 3]).toBe(out.image.data[i + 3]);
      if (black.image.data[i + 3]) expect(black.image.data[i] + black.image.data[i + 1] + black.image.data[i + 2]).toBe(0);
    }
  });

  it('sensitivity moves the threshold: higher picks up more, lower less', () => {
    const count = (s: number) => {
      const r = extractInk(prep, { sensitivity: s })!;
      let n = 0;
      for (let i = 3; i < r.image.data.length; i += 4) if (r.image.data[i] > 0) n++;
      return n;
    };
    expect(thresholdFor(prep.threshold, 0)).toBeGreaterThan(thresholdFor(prep.threshold, 50));
    expect(thresholdFor(prep.threshold, 100)).toBeLessThan(thresholdFor(prep.threshold, 50));
    expect(count(90)).toBeGreaterThan(count(50));
    expect(count(10)).toBeLessThan(count(50));
  });

  it('darkens faint ink enough to read', () => {
    const faint = photo({ ink: [175, 175, 190], seed: 3 });
    const r = extractInk(prepareSignature(faint.img))!;
    expect(r).not.toBeNull();
    const [cx, cy] = faint.strokeCentres[20];
    const [red, g, b, a] = at(r.image, Math.round(cx) - r.box.x, Math.round(cy) - r.box.y);
    expect(a).toBe(255);
    expect(0.299 * red + 0.587 * g + 0.114 * b).toBeLessThan(110);
  });

  it('keeps black ink black', () => {
    const blackInk = photo({ ink: [20, 20, 25], seed: 5 });
    const r = extractInk(prepareSignature(blackInk.img))!;
    const [cx, cy] = blackInk.strokeCentres[10];
    const [red, g, b, a] = at(r.image, Math.round(cx) - r.box.x, Math.round(cy) - r.box.y);
    expect(a).toBe(255);
    expect(Math.max(red, g, b)).toBeLessThan(60);
  });

  it('finds nothing on blank paper', () => {
    const width = 300;
    const height = 200;
    const random = rng(11);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      const v = 230 + random() * 8;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v - 20;
      data[i + 3] = 255;
    }
    expect(extractInk(prepareSignature({ data, width, height }))).toBeNull();
  });

  it('caps the working size at 2000 px on the long edge, never enlarging', () => {
    expect(workingScale(4000, 3000)).toBe(0.5);
    expect(workingScale(800, 600)).toBe(1);
  });
});
