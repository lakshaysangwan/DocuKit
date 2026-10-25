/**
 * Pick the signature out of a photo or scan of it: the paper becomes
 * transparent, the ink stays (in its own colour, or black), and the result is
 * cropped to the ink.
 *
 * Pure: works on raw RGBA pixels, so it runs in a unit test and in a worker.
 *
 * Two steps, so a "Sensitivity" slider stays live:
 *
 * 1. `prepareSignature` (the slow part, once per photo): estimate the paper's
 *    colour across the photo — a coarse grid of bright-percentile samples,
 *    smoothed and interpolated — and divide it out. That evens out a lighting
 *    gradient and grey or yellowish paper, and white-balances the ink. Then
 *    choose an automatic threshold on how dark each pixel is (Otsu's method,
 *    kept above the paper's own noise).
 * 2. `extractInk` (per slider move): threshold, drop specks (connected pieces
 *    much smaller than a dot made with the same pen), give stroke edges a soft
 *    alpha ramp, darken faint ink, crop.
 */

/** RGBA pixels, row by row. `ImageData` is one. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface InkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The photo with its paper divided out; reused for every slider position. */
export interface PreparedSignature {
  width: number;
  height: number;
  /** White-balanced colour, 3 bytes a pixel: paper ≈ 255, 255, 255. */
  rgb: Uint8ClampedArray;
  /** How much darker than the paper each pixel is, 0 (paper) to 255 (black). */
  dark: Uint8Array;
  /** The automatic threshold on `dark`, before sensitivity. */
  threshold: number;
}

export interface ExtractOptions {
  /** 0–100, default 50. Higher picks up fainter ink (and more marks). */
  sensitivity?: number;
  /** Draw every ink pixel black instead of in its own colour. */
  black?: boolean;
  /** Clear pixels kept around the ink. Default 4. */
  margin?: number;
}

export interface ExtractedInk {
  /** The cropped signature, transparent where the paper was. */
  image: RgbaImage;
  /** Where that crop is in the prepared image. */
  box: InkBox;
  /** The threshold used, after sensitivity. */
  threshold: number;
}

/** Long edge a photo is reduced to before extraction: plenty for a signature, quick on a phone. */
export const MAX_WORKING_EDGE = 2000;

const DEFAULT_SENSITIVITY = 50;
/** Bright percentile of each grid cell taken as the paper there: ignores ink and bright noise. */
const PAPER_PERCENTILE = 0.8;

/** Scale that brings `width × height` within `MAX_WORKING_EDGE` (never enlarges). */
export function workingScale(width: number, height: number, maxEdge = MAX_WORKING_EDGE): number {
  return Math.min(1, maxEdge / Math.max(width, height, 1));
}

/* ── Step 1: paper estimate and threshold ──────────────────────────────── */

export function prepareSignature(img: RgbaImage): PreparedSignature {
  const { width: w, height: h, data } = img;
  const n = w * h;

  // A grid of cells about 1/32 of the long edge: big enough that a pen stroke
  // never fills one, small enough to follow a shadow or a lighting gradient.
  const cell = Math.max(8, Math.round(Math.max(w, h) / 32));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const grid = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  const hist = new Uint32Array(256 * 3);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      const x0 = gx * cell;
      const y0 = gy * cell;
      const x1 = Math.min(w, x0 + cell);
      const y1 = Math.min(h, y0 + cell);
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          // Transparent pixels (a PNG) count as white paper.
          const a = data[i + 3];
          if (a < 255) {
            const k = 255 - a;
            hist[(data[i] * a + 255 * k) / 255 | 0]++;
            hist[256 + ((data[i + 1] * a + 255 * k) / 255 | 0)]++;
            hist[512 + ((data[i + 2] * a + 255 * k) / 255 | 0)]++;
          } else {
            hist[data[i]]++;
            hist[256 + data[i + 1]]++;
            hist[512 + data[i + 2]]++;
          }
        }
      }
      const count = (x1 - x0) * (y1 - y0);
      const target = count * PAPER_PERCENTILE;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let v = 0;
        for (; v < 255; v++) {
          sum += hist[c * 256 + v];
          if (sum >= target) break;
        }
        grid[c][gy * gw + gx] = Math.max(v, 16);
      }
    }
  }

  // A cell mostly covered by ink (a thick stroke, a big blot) reads too dark:
  // take the brightest neighbour, then smooth, so it borrows the paper around it.
  for (let c = 0; c < 3; c++) grid[c] = blurGrid(maxGrid(grid[c], gw, gh), gw, gh);

  // Divide the paper out, interpolating the grid between cell centres.
  const rgb = new Uint8ClampedArray(n * 3);
  const dark = new Uint8Array(n);
  const rowBg = [new Float32Array(gw), new Float32Array(gw), new Float32Array(gw)];
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const gy0 = Math.floor(fy);
    const gy1 = Math.min(gh - 1, gy0 + 1);
    const ty = fy - gy0;
    for (let c = 0; c < 3; c++) {
      const g = grid[c];
      const row = rowBg[c];
      for (let gx = 0; gx < gw; gx++) row[gx] = g[gy0 * gw + gx] * (1 - ty) + g[gy1 * gw + gx] * ty;
    }
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const gx0 = Math.floor(fx);
      const gx1 = Math.min(gw - 1, gx0 + 1);
      const tx = fx - gx0;
      const p = y * w + x;
      const i = p * 4;
      const a = data[i + 3];
      const k = 255 - a;
      let lum = 0;
      for (let c = 0; c < 3; c++) {
        const bg = rowBg[c][gx0] * (1 - tx) + rowBg[c][gx1] * tx;
        const v = a < 255 ? (data[i + c] * a + 255 * k) / 255 : data[i + c];
        const out = Math.min(255, (v * 255) / bg);
        rgb[p * 3 + c] = out;
        lum += out * (c === 0 ? 0.299 : c === 1 ? 0.587 : 0.114);
      }
      dark[p] = 255 - Math.min(255, Math.round(lum));
    }
  }

  return { width: w, height: h, rgb, dark, threshold: autoThreshold(dark) };
}

function maxGrid(g: Float32Array, gw: number, gh: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(g.length);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= gw) continue;
          m = Math.max(m, g[yy * gw + xx]);
        }
      }
      out[y * gw + x] = m;
    }
  }
  return out;
}

function blurGrid(g: Float32Array, gw: number, gh: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(g.length);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= gw) continue;
          s += g[yy * gw + xx];
          c++;
        }
      }
      out[y * gw + x] = s / c;
    }
  }
  return out;
}

/**
 * Otsu's threshold on the darkness histogram, kept clear of the paper's own
 * noise (its median plus several spreads) and within sensible bounds.
 */
export function autoThreshold(dark: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < dark.length; i++) hist[dark[i]]++;
  const total = dark.length;
  if (!total) return 64;

  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let otsu = 64;
  for (let t = 0; t < 255; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      otsu = t;
    }
  }

  const pct = (q: number) => {
    const target = total * q;
    let sum = 0;
    for (let v = 0; v < 256; v++) {
      sum += hist[v];
      if (sum >= target) return v;
    }
    return 255;
  };
  const median = pct(0.5);
  const spread = Math.max(2, pct(0.75) - pct(0.25));
  const noiseFloor = median + 5 * spread;
  return Math.round(Math.min(140, Math.max(24, otsu, noiseFloor)));
}

/** The threshold for a sensitivity: 50 is the automatic one, 0 doubles it, 100 halves it. */
export function thresholdFor(base: number, sensitivity = DEFAULT_SENSITIVITY): number {
  const s = Math.min(100, Math.max(0, sensitivity));
  return Math.min(230, Math.max(6, Math.round(base * 2 ** ((DEFAULT_SENSITIVITY - s) / 50))));
}

/* ── Step 2: ink ───────────────────────────────────────────────────────── */

export function extractInk(prep: PreparedSignature, options: ExtractOptions = {}): ExtractedInk | null {
  const { width: w, height: h, dark, rgb } = prep;
  const n = w * h;
  const t = thresholdFor(prep.threshold, options.sensitivity);
  const margin = options.margin ?? 4;

  // Connected pieces of ink (8-connected), with their areas and edge lengths.
  const labels = new Int32Array(n);
  const parent: number[] = [0];
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (dark[p] <= t) continue;
      let l = 0;
      for (let k = 0; k < 4; k++) {
        const nb =
          k === 0 ? (x > 0 ? labels[p - 1] : 0)
          : k === 1 ? (y > 0 && x > 0 ? labels[p - w - 1] : 0)
          : k === 2 ? (y > 0 ? labels[p - w] : 0)
          : y > 0 && x < w - 1 ? labels[p - w + 1] : 0;
        if (!nb) continue;
        if (!l) l = nb;
        else if (nb !== l) union(l, nb);
      }
      if (!l) {
        l = parent.length;
        parent.push(l);
      }
      labels[p] = l;
    }
  }
  if (parent.length === 1) return null;

  const roots = new Int32Array(parent.length);
  for (let l = 1; l < parent.length; l++) roots[l] = find(l);
  const area = new Float64Array(parent.length);
  const edge = new Float64Array(parent.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const l = labels[p];
      if (!l) continue;
      const r = roots[l];
      labels[p] = r;
      area[r]++;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1 || dark[p - 1] <= t || dark[p + 1] <= t || dark[p - w] <= t || dark[p + w] <= t) {
        edge[r]++;
      }
    }
  }

  // How thick the pen is, from the biggest piece (area ÷ half its outline).
  // A dot made with that pen is about a pen-width across; anything much
  // smaller is a speck.
  let biggest = 0;
  for (let r = 1; r < area.length; r++) if (area[r] > area[biggest]) biggest = r;
  if (!biggest) return null;
  const penWidth = Math.max(1, (2 * area[biggest]) / Math.max(1, edge[biggest]));
  const minArea = Math.max(6, 0.35 * penWidth * penWidth);
  const keep = new Uint8Array(area.length);
  for (let r = 1; r < area.length; r++) if (area[r] >= minArea) keep[r] = 1;

  const kept = new Uint8Array(n);
  let coreSum = 0;
  let coreCount = 0;
  for (let p = 0; p < n; p++) {
    if (labels[p] && keep[labels[p]]) {
      kept[p] = 1;
      coreSum += dark[p];
      coreCount++;
    }
  }
  if (!coreCount) return null;

  // Soft edges reach a couple of pixels past the kept ink, never further, so
  // the faint halo of a speck that was dropped does not come back.
  const near = dilate(kept, w, h, 2);
  const inkDark = coreSum / coreCount;
  const lo = t * 0.6;
  const hi = Math.max(t + 1, Math.min(inkDark, t + Math.max(8, t * 0.5)));
  // Faint ink (pencil, a light pen, an over-exposed photo) is darkened so it reads.
  const gain = Math.min(4, Math.max(1, 150 / inkDark));

  const alpha = new Uint8Array(n);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!near[p]) continue;
      const d = dark[p];
      if (d <= lo) continue;
      let a = Math.min(1, (d - lo) / (hi - lo));
      a = a * a * (3 - 2 * a);
      const v = Math.round(a * 255);
      if (!v) continue;
      alpha[p] = v;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const bx = Math.max(0, minX - margin);
  const by = Math.max(0, minY - margin);
  const bw = Math.min(w, maxX + 1 + margin) - bx;
  const bh = Math.min(h, maxY + 1 + margin) - by;
  const out = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const p = (by + y) * w + (bx + x);
      const a = alpha[p];
      if (!a) continue;
      const o = (y * bw + x) * 4;
      out[o + 3] = a;
      if (options.black) continue;
      // An edge pixel is part ink, part paper: take the paper back out, as if
      // the pixel were all ink, then apply the gain for faint ink.
      const mix = Math.min(1, Math.max(0.2, dark[p] / inkDark));
      for (let c = 0; c < 3; c++) {
        const lightness = 255 - rgb[p * 3 + c];
        out[o + c] = 255 - Math.min(255, (lightness / mix) * gain);
      }
    }
  }
  return { image: { data: out, width: bw, height: bh }, box: { x: bx, y: by, width: bw, height: bh }, threshold: t };
}

/** Square dilation by `r` pixels, done as two one-dimensional passes. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    // Forward then backward: distance to the nearest set pixel along the row.
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) tmp[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x;
      if (last - x <= r) tmp[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}
