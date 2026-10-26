import { describe, it, expect } from 'vitest';
import {
  MIN_BOX_WIDTH,
  centreRectAt,
  clampRect,
  moveRect,
  moveRectCentre,
  resizeFromCorner,
  sameRect,
  scaleRect,
} from './overlay-math';
import type { RectNorm } from '../pdf/page-geometry';

const BOX: RectNorm = { x: 0.3, y: 0.4, width: 0.2, height: 0.1 };

function expectRect(actual: RectNorm, expected: RectNorm) {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.width).toBeCloseTo(expected.width, 9);
  expect(actual.height).toBeCloseTo(expected.height, 9);
}

const onPage = (r: RectNorm) =>
  r.x >= -1e-12 && r.y >= -1e-12 && r.x + r.width <= 1 + 1e-12 && r.y + r.height <= 1 + 1e-12;

describe('clampRect / moveRect / centreRectAt', () => {
  it('leaves a box that is already on the page alone', () => {
    expectRect(clampRect(BOX), BOX);
  });

  it('moves a box back inside without changing its size', () => {
    expectRect(clampRect({ x: -0.1, y: 0.95, width: 0.2, height: 0.1 }), { x: 0, y: 0.9, width: 0.2, height: 0.1 });
  });

  it('scales a box that is larger than the page, keeping its shape', () => {
    const r = clampRect({ x: 0.2, y: 0.2, width: 2, height: 0.5 });
    expectRect(r, { x: 0, y: 0.2, width: 1, height: 0.25 });
  });

  it('moves by a delta and stops at the edges', () => {
    expectRect(moveRect(BOX, 0.1, -0.1), { ...BOX, x: 0.4, y: 0.3 });
    expectRect(moveRect(BOX, 5, 5), { ...BOX, x: 0.8, y: 0.9 });
    expectRect(moveRect(BOX, -5, -5), { ...BOX, x: 0, y: 0 });
  });

  it('centres on a point, stopping at the edges', () => {
    expectRect(centreRectAt(BOX, 0.5, 0.5), { ...BOX, x: 0.4, y: 0.45 });
    expectRect(centreRectAt(BOX, 0, 1), { ...BOX, x: 0, y: 0.9 });
  });
});

describe('resizeFromCorner', () => {
  it('bottom-right grows the box and keeps the top-left corner fixed', () => {
    const r = resizeFromCorner(BOX, 'bottom-right', 0.1, 0.05);
    expectRect(r, { x: 0.3, y: 0.4, width: 0.3, height: 0.15 });
  });

  it('top-left keeps the bottom-right corner fixed', () => {
    const r = resizeFromCorner(BOX, 'top-left', -0.1, -0.05);
    expectRect(r, { x: 0.2, y: 0.35, width: 0.3, height: 0.15 });
    expect(r.x + r.width).toBeCloseTo(BOX.x + BOX.width, 9);
    expect(r.y + r.height).toBeCloseTo(BOX.y + BOX.height, 9);
  });

  it('top-right and bottom-left keep their opposite corners fixed', () => {
    const tr = resizeFromCorner(BOX, 'top-right', 0.1, -0.05);
    expectRect(tr, { x: 0.3, y: 0.35, width: 0.3, height: 0.15 });
    const bl = resizeFromCorner(BOX, 'bottom-left', -0.1, 0.05);
    expectRect(bl, { x: 0.2, y: 0.4, width: 0.3, height: 0.15 });
  });

  it('keeps the shape when the pointer moves along one axis only', () => {
    for (const [dx, dy] of [[0.1, 0], [0, 0.05], [0.04, 0.2], [-0.05, -0.01]]) {
      const r = resizeFromCorner(BOX, 'bottom-right', dx, dy);
      expect(r.width / r.height).toBeCloseTo(BOX.width / BOX.height, 9);
    }
  });

  it('follows the axis that moved further relative to the box', () => {
    // 0.1 is 50% of the width, 0.01 is 10% of the height: width wins.
    expectRect(resizeFromCorner(BOX, 'bottom-right', 0.1, 0.01), { x: 0.3, y: 0.4, width: 0.3, height: 0.15 });
  });

  it('never grows past the page edge, on either axis', () => {
    const r = resizeFromCorner(BOX, 'bottom-right', 5, 5);
    expect(onPage(r)).toBe(true);
    // The right edge is 0.7 away → 3.5×; the bottom is 0.6 away → 6×. Width limits.
    expectRect(r, { x: 0.3, y: 0.4, width: 0.7, height: 0.35 });

    const up = resizeFromCorner(BOX, 'top-left', -5, -5);
    expect(onPage(up)).toBe(true);
    expect(up.x).toBeCloseTo(0, 9);
  });

  it('never shrinks below the minimum width', () => {
    const r = resizeFromCorner(BOX, 'bottom-right', -5, -5);
    expect(r.width).toBeCloseTo(MIN_BOX_WIDTH, 9);
    expect(r.width / r.height).toBeCloseTo(2, 9);
    expectRect({ ...r, width: 0, height: 0 }, { x: 0.3, y: 0.4, width: 0, height: 0 });
  });

  it('honours a custom minimum', () => {
    expect(resizeFromCorner(BOX, 'bottom-right', -5, -5, { minWidth: 0.1 }).width).toBeCloseTo(0.1, 9);
  });

  it('resizes each axis on its own when the aspect is not locked', () => {
    const r = resizeFromCorner(BOX, 'bottom-right', 0.1, 0, { lockAspect: false });
    expectRect(r, { x: 0.3, y: 0.4, width: 0.3, height: 0.1 });
    expect(onPage(resizeFromCorner(BOX, 'top-right', 9, -9, { lockAspect: false }))).toBe(true);
  });
});

describe('scaleRect', () => {
  it('grows and shrinks about the centre', () => {
    const bigger = scaleRect(BOX, 1.5);
    expectRect(bigger, { x: 0.25, y: 0.375, width: 0.3, height: 0.15 });
    const smaller = scaleRect(BOX, 0.5);
    expectRect(smaller, { x: 0.35, y: 0.425, width: 0.1, height: 0.05 });
  });

  it('stays on the page when growing next to an edge', () => {
    const r = scaleRect({ x: 0.85, y: 0.9, width: 0.15, height: 0.1 }, 2);
    expect(onPage(r)).toBe(true);
    expect(r.width).toBeCloseTo(0.3, 9);
  });

  it('stops at the page size and at the minimum width', () => {
    const max = scaleRect(BOX, 100);
    expect(max.width).toBeCloseTo(1, 9);
    expect(onPage(max)).toBe(true);
    expect(scaleRect(BOX, 0.0001).width).toBeCloseTo(MIN_BOX_WIDTH, 9);
  });
});

describe('moveRectCentre', () => {
  it('moves freely while the centre is on the page, letting the box hang over the edge', () => {
    const big: RectNorm = { x: 0.1, y: 0.1, width: 0.6, height: 0.2 };
    const moved = moveRectCentre(big, -0.3, 0);
    expect(moved.x).toBeCloseTo(-0.2, 9);
    expect(moved.width).toBe(0.6);
  });

  it('stops the centre at the page edge and never resizes', () => {
    const big: RectNorm = { x: 0.1, y: 0.1, width: 1.4, height: 0.2 };
    const moved = moveRectCentre(big, 5, -5);
    expect(moved.x + moved.width / 2).toBeCloseTo(1, 9);
    expect(moved.y + moved.height / 2).toBeCloseTo(0, 9);
    expect(moved.width).toBe(1.4);
  });
});

describe('sameRect', () => {
  it('compares within a tolerance', () => {
    expect(sameRect(BOX, { ...BOX })).toBe(true);
    expect(sameRect(BOX, { ...BOX, x: BOX.x + 1e-9 })).toBe(true);
    expect(sameRect(BOX, { ...BOX, x: BOX.x + 0.01 })).toBe(false);
  });
});
