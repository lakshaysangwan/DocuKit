/**
 * Resize Image: the size of the output, where the image goes in it, and what
 * the file is called. Pure — no DOM, no canvas.
 *
 * `resizeLayout` is the one piece of geometry the tool has. The preview draws
 * the image at exactly its `draw` box inside a frame of `width × height`, and
 * the writer (`resizeImage` in image-ops.ts) draws the decoded image at the
 * same box on a canvas of that size. So the frame on screen is the file: there
 * is no second copy of this arithmetic to drift.
 *
 * Every number is in output pixels, origin top-left, y down. `draw` may reach
 * past the frame (Cover); the frame clips it.
 */
import { extForMime } from './compress-image';

export type FitMode = 'fit' | 'cover' | 'stretch';
export type SizeMode = 'exact' | 'percent';
export type ResizeBackground = 'white' | 'black' | 'transparent';

/** The longest side an output may have. Larger canvases fail on phones and in Safari. */
export const MAX_SIDE = 10_000;
export const MIN_PERCENT = 1;
export const MAX_PERCENT = 400;
/** Quality for the lossy formats (JPEG, WebP, AVIF). */
export const RESIZE_QUALITY = 92;

export const FIT_LABEL: Record<FitMode, string> = {
  fit: 'Fit',
  cover: 'Cover',
  stretch: 'Stretch',
};

export const BACKGROUND_CSS: Record<ResizeBackground, string | null> = {
  white: '#ffffff',
  black: '#000000',
  transparent: null,
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResizeLayoutInput {
  /** The source image's pixel size, as it is shown (EXIF orientation applied). */
  srcW: number;
  srcH: number;
  /** The output frame, in pixels. */
  outW: number;
  outH: number;
  mode: FitMode;
  /**
   * Cover only: which part of the image is kept where it overflows, 0–1 on each
   * axis (0 keeps the left / top edge, 1 the right / bottom, 0.5 the middle).
   */
  focusX?: number;
  focusY?: number;
}

export interface ResizeLayout {
  width: number;
  height: number;
  /** Where the image is drawn in the frame. */
  draw: Rect;
  /** Cover: the image is wider / taller than the frame, so that side is cropped. */
  cropX: boolean;
  cropY: boolean;
  /** Fit: the image is narrower / shorter than the frame, so background shows on that side. */
  barsX: boolean;
  barsY: boolean;
}

const clamp01 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? 0.5 : Math.min(1, Math.max(0, v)));
/** Less than this many pixels of overflow or gap is rounding, not a crop or a bar. */
const EPS = 0.5;

/** Where the image goes in a `outW × outH` frame under a fit mode. */
export function resizeLayout({ srcW, srcH, outW, outH, mode, focusX, focusY }: ResizeLayoutInput): ResizeLayout {
  const W = Math.max(1, Math.round(outW));
  const H = Math.max(1, Math.round(outH));
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  if (mode === 'stretch') {
    return { width: W, height: H, draw: { x: 0, y: 0, w: W, h: H }, cropX: false, cropY: false, barsX: false, barsY: false };
  }
  const scale = mode === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const w = sw * scale;
  const h = sh * scale;
  // Fit centres the image; Cover slides it by the focus, keeping it over the whole frame.
  const fx = mode === 'cover' ? clamp01(focusX) : 0.5;
  const fy = mode === 'cover' ? clamp01(focusY) : 0.5;
  return {
    width: W,
    height: H,
    // `+ 0` turns -0 (an image exactly as wide as the frame, focus 0) into 0.
    draw: { x: (W - w) * fx + 0, y: (H - h) * fy + 0, w, h },
    cropX: w - W > EPS,
    cropY: h - H > EPS,
    barsX: W - w > EPS,
    barsY: H - h > EPS,
  };
}

/**
 * Move the Cover focus by a drag of `dx, dy` output pixels (the way the image
 * moved under the pointer). Returns the new focus, clamped to the image's edges.
 */
export function dragFocus(layout: ResizeLayout, focus: { x: number; y: number }, dx: number, dy: number) {
  const spareX = layout.width - layout.draw.w; // ≤ 0 when cropped
  const spareY = layout.height - layout.draw.h;
  return {
    x: spareX < -EPS ? clamp01(focus.x + dx / spareX) : focus.x,
    y: spareY < -EPS ? clamp01(focus.y + dy / spareY) : focus.y,
  };
}

/** The settings that decide every output's size. */
export interface ResizeSettings {
  sizeMode: SizeMode;
  /** Exact mode. */
  width: number;
  height: number;
  /** Percent mode: 1–400. */
  percent: number;
}

/** The output size for one source image. Percent mode keeps each image's own proportions. */
export function outputSize(srcW: number, srcH: number, s: ResizeSettings): { width: number; height: number } {
  if (s.sizeMode === 'percent') {
    const k = s.percent / 100;
    return { width: Math.max(1, Math.round(srcW * k)), height: Math.max(1, Math.round(srcH * k)) };
  }
  return { width: Math.round(s.width), height: Math.round(s.height) };
}

/** The fit mode a run uses: percent mode keeps proportions, so the image fills its frame. */
export const effectiveMode = (s: ResizeSettings, mode: FitMode): FitMode => (s.sizeMode === 'percent' ? 'stretch' : mode);

/** Why these settings cannot run, or null. `sources` are the images' pixel sizes. */
export function settingsProblem(s: ResizeSettings, sources: { width: number; height: number }[]): string | null {
  if (s.sizeMode === 'percent') {
    if (!Number.isFinite(s.percent) || s.percent < MIN_PERCENT || s.percent > MAX_PERCENT) {
      return `Enter a percentage from ${MIN_PERCENT} to ${MAX_PERCENT}`;
    }
  } else {
    if (!Number.isFinite(s.width) || !Number.isFinite(s.height) || s.width < 1 || s.height < 1) {
      return 'Enter a width and a height of at least 1 px';
    }
    if (!Number.isInteger(s.width) || !Number.isInteger(s.height)) return 'Enter the width and height in whole pixels';
  }
  for (const src of sources) {
    const out = outputSize(src.width, src.height, s);
    if (out.width > MAX_SIDE || out.height > MAX_SIDE) {
      return `The output can be at most ${MAX_SIDE.toLocaleString('en-US')} px on a side`;
    }
  }
  const unchanged = sources.length > 0 && sources.every((src) => {
    const out = outputSize(src.width, src.height, s);
    return out.width === src.width && out.height === src.height;
  });
  if (unchanged) {
    return sources.length > 1 ? 'Choose a new size: these are the sizes the images already have' : 'Choose a new size: this is the size the image already has';
  }
  return null;
}

/** The format the resized file is saved in, from the input's real format. */
export function outputMimeFor(inputMime: string | null): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif' {
  switch (inputMime) {
    case 'image/png':
    case 'image/gif': // first frame, transparency kept
    case 'image/bmp': // lossless in, lossless out
      return 'image/png';
    case 'image/webp':
      return 'image/webp';
    case 'image/avif':
      return 'image/avif';
    default: // JPEG, HEIC and anything else
      return 'image/jpeg';
  }
}

/** JPEG has no transparency. */
export const keepsTransparency = (mime: string) => mime !== 'image/jpeg';

/** The background to use: transparent where it cannot be kept becomes white. */
export const backgroundFor = (mime: string, chosen: ResizeBackground): ResizeBackground =>
  chosen === 'transparent' && !keepsTransparency(mime) ? 'white' : chosen;

/** "holiday.heic" + 1280×720 JPEG → "holiday-1280x720.jpg". */
export function resizedFileName(inputName: string, width: number, height: number, mime: string): string {
  const base = inputName.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}-${width}x${height}.${extForMime(mime)}`;
}

const BG_NAME: Record<ResizeBackground, string> = { white: 'white', black: 'black', transparent: 'transparent' };

/** One sentence saying where the image goes, for the stage and the controls. */
export function describeLayout(layout: ResizeLayout, mode: FitMode, background: ResizeBackground): string {
  const { width: W, height: H, draw } = layout;
  if (mode === 'stretch') {
    return `The image is stretched to fill ${W} × ${H} px.`;
  }
  if (mode === 'cover') {
    if (layout.cropX) return `The image fills ${W} × ${H} px; ${Math.round(draw.w - W)} px of its width is cropped.`;
    if (layout.cropY) return `The image fills ${W} × ${H} px; ${Math.round(draw.h - H)} px of its height is cropped.`;
    return `The image fills ${W} × ${H} px exactly.`;
  }
  const size = `${Math.round(draw.w)} × ${Math.round(draw.h)} px`;
  if (layout.barsX) return `The image is ${size}, with ${BG_NAME[background]} bars left and right.`;
  if (layout.barsY) return `The image is ${size}, with ${BG_NAME[background]} bars above and below.`;
  return `The image fills ${W} × ${H} px exactly.`;
}
