import { describe, expect, it } from 'vitest';
import {
  MAX_SIDE,
  backgroundFor,
  describeLayout,
  dragFocus,
  effectiveMode,
  outputMimeFor,
  outputSize,
  resizeLayout,
  resizedFileName,
  settingsProblem,
  type ResizeSettings,
} from './resize-image';

const exact = (width: number, height: number): ResizeSettings => ({ sizeMode: 'exact', width, height, percent: 100 });
const percent = (p: number): ResizeSettings => ({ sizeMode: 'percent', width: 0, height: 0, percent: p });

describe('resizeLayout', () => {
  it('Stretch fills the frame whatever the shape', () => {
    const l = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'stretch' });
    expect(l.draw).toEqual({ x: 0, y: 0, w: 500, h: 500 });
    expect([l.cropX, l.cropY, l.barsX, l.barsY]).toEqual([false, false, false, false]);
  });

  it('Fit scales to the shorter side and centres, leaving bars on the other', () => {
    // 3:2 into a square: 500 wide, 333.3 tall, bars above and below.
    const l = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'fit' });
    expect(l.draw.x).toBe(0);
    expect(l.draw.w).toBe(500);
    expect(l.draw.h).toBeCloseTo(333.333, 2);
    expect(l.draw.y).toBeCloseTo(83.333, 2);
    expect(l.barsY).toBe(true);
    expect(l.barsX).toBe(false);
    expect(l.cropX || l.cropY).toBe(false);
  });

  it('Fit ignores the focus: it always centres', () => {
    const l = resizeLayout({ srcW: 900, srcH: 1200, outW: 1280, outH: 720, mode: 'fit', focusX: 0, focusY: 0 });
    expect(l.draw.h).toBe(720);
    expect(l.draw.w).toBe(540);
    expect(l.draw.x).toBe((1280 - 540) / 2);
    expect(l.barsX).toBe(true);
  });

  it('Cover fills the frame and centres by default, cropping the long side', () => {
    const l = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'cover' });
    expect(l.draw.h).toBe(500);
    expect(l.draw.w).toBe(750);
    expect(l.draw.x).toBe(-125);
    expect(l.draw.y).toBe(0);
    expect(l.cropX).toBe(true);
    expect(l.cropY).toBe(false);
  });

  it('Cover keeps the edge the focus asks for', () => {
    const left = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'cover', focusX: 0 });
    const right = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'cover', focusX: 1 });
    expect(left.draw.x).toBe(0);
    expect(right.draw.x).toBe(-250);
    expect(right.draw.x + right.draw.w).toBe(500);
    // The focus on the axis with no overflow changes nothing.
    const top = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'cover', focusY: 0 });
    expect(top.draw.y).toBe(0);
  });

  it('a focus out of range or missing is clamped / centred', () => {
    const l = resizeLayout({ srcW: 800, srcH: 1200, outW: 400, outH: 400, mode: 'cover', focusY: 7 });
    expect(l.draw.y).toBe(400 - 600);
    const n = resizeLayout({ srcW: 800, srcH: 1200, outW: 400, outH: 400, mode: 'cover', focusY: Number.NaN });
    expect(n.draw.y).toBe(-100);
  });

  it('the same shape is neither cropped nor barred', () => {
    for (const mode of ['fit', 'cover'] as const) {
      const l = resizeLayout({ srcW: 1200, srcH: 800, outW: 600, outH: 400, mode });
      expect(l.draw).toEqual({ x: 0, y: 0, w: 600, h: 400 });
      expect([l.cropX, l.cropY, l.barsX, l.barsY]).toEqual([false, false, false, false]);
    }
  });

  it('rounding of a locked aspect is not reported as a crop or a bar', () => {
    // 1200×800 at width 301 locks to height 201 (200.67 rounded).
    const l = resizeLayout({ srcW: 1200, srcH: 800, outW: 301, outH: 201, mode: 'fit' });
    expect(l.barsX || l.barsY).toBe(false);
  });
});

describe('dragFocus', () => {
  const layout = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'cover' });

  it('dragging the image right shows more of its left side', () => {
    const f = dragFocus(layout, { x: 0.5, y: 0.5 }, 125, 0);
    expect(f.x).toBe(0);
    const g = dragFocus(layout, { x: 0.5, y: 0.5 }, -62.5, 0);
    expect(g.x).toBe(0.75);
  });

  it('stops at the edges and leaves the uncropped axis alone', () => {
    const f = dragFocus(layout, { x: 0.5, y: 0.5 }, 1000, 1000);
    expect(f).toEqual({ x: 0, y: 0.5 });
  });

  it('a drag moves the drawn image by the drag (until an edge)', () => {
    const f = dragFocus(layout, { x: 0.5, y: 0.5 }, 40, 0);
    const moved = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'cover', focusX: f.x });
    expect(moved.draw.x - layout.draw.x).toBeCloseTo(40, 6);
  });
});

describe('outputSize and settings', () => {
  it('exact mode uses the width and height as given', () => {
    expect(outputSize(1200, 800, exact(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it('percent mode scales each image by its own size', () => {
    expect(outputSize(1200, 800, percent(50))).toEqual({ width: 600, height: 400 });
    expect(outputSize(900, 1200, percent(50))).toEqual({ width: 450, height: 600 });
    expect(outputSize(3, 3, percent(1))).toEqual({ width: 1, height: 1 });
  });

  it('percent mode keeps proportions, so it never letterboxes', () => {
    expect(effectiveMode(percent(50), 'fit')).toBe('stretch');
    expect(effectiveMode(exact(10, 10), 'cover')).toBe('cover');
  });

  it('says why settings cannot run', () => {
    const src = [{ width: 1200, height: 800 }];
    expect(settingsProblem(exact(0, 400), src)).toMatch(/at least 1 px/);
    expect(settingsProblem(exact(Number.NaN, 400), src)).toMatch(/at least 1 px/);
    expect(settingsProblem(exact(10.5, 400), src)).toMatch(/whole pixels/);
    expect(settingsProblem(exact(MAX_SIDE + 1, 400), src)).toMatch(/at most 10,000 px/);
    expect(settingsProblem(percent(0), src)).toMatch(/1 to 400/);
    expect(settingsProblem(percent(401), src)).toMatch(/1 to 400/);
    expect(settingsProblem(percent(1000 / 1.2), src)).toMatch(/1 to 400/);
    expect(settingsProblem(exact(1200, 800), src)).toMatch(/already has/);
    expect(settingsProblem(percent(100), src)).toMatch(/already has/);
    expect(settingsProblem(exact(600, 400), src)).toBeNull();
    // A percentage that would exceed the limit on any image.
    expect(settingsProblem(percent(400), [{ width: 3000, height: 2000 }])).toMatch(/at most/);
  });

  it('a batch is unchanged only when every image already has the size', () => {
    const srcs = [{ width: 1200, height: 800 }, { width: 900, height: 1200 }];
    expect(settingsProblem(exact(1200, 800), srcs)).toBeNull();
    expect(settingsProblem(percent(100), srcs)).toMatch(/these are the sizes/);
  });
});

describe('formats and names', () => {
  it('keeps the format where it can, PNG for GIF and BMP, JPEG for HEIC', () => {
    expect(outputMimeFor('image/jpeg')).toBe('image/jpeg');
    expect(outputMimeFor('image/png')).toBe('image/png');
    expect(outputMimeFor('image/webp')).toBe('image/webp');
    expect(outputMimeFor('image/avif')).toBe('image/avif');
    expect(outputMimeFor('image/gif')).toBe('image/png');
    expect(outputMimeFor('image/bmp')).toBe('image/png');
    expect(outputMimeFor('image/heic')).toBe('image/jpeg');
    expect(outputMimeFor(null)).toBe('image/jpeg');
  });

  it('JPEG cannot be transparent', () => {
    expect(backgroundFor('image/jpeg', 'transparent')).toBe('white');
    expect(backgroundFor('image/png', 'transparent')).toBe('transparent');
    expect(backgroundFor('image/jpeg', 'black')).toBe('black');
  });

  it('names the file by its size and its real format', () => {
    expect(resizedFileName('holiday.heic', 1280, 720, 'image/jpeg')).toBe('holiday-1280x720.jpg');
    expect(resizedFileName('logo.final.png', 64, 64, 'image/png')).toBe('logo.final-64x64.png');
    expect(resizedFileName('.png', 1, 1, 'image/png')).toBe('image-1x1.png');
  });
});

describe('describeLayout', () => {
  it('says what happens to the image', () => {
    const fit = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'fit' });
    expect(describeLayout(fit, 'fit', 'white')).toBe('The image is 500 × 333 px, with white bars above and below.');
    const cover = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'cover' });
    expect(describeLayout(cover, 'cover', 'white')).toBe('The image fills 500 × 500 px; 250 px of its width is cropped.');
    const stretch = resizeLayout({ srcW: 1200, srcH: 800, outW: 500, outH: 500, mode: 'stretch' });
    expect(describeLayout(stretch, 'stretch', 'white')).toBe('The image is stretched to fill 500 × 500 px.');
  });
});
