import { describe, expect, it } from 'vitest';
import { NEIGHBOUR_GAP, PHRASE_PAD, phraseMarkBox, quadToBox, type Box } from './phrase-marks';

/** A line of 10-wide, 20-tall character boxes starting at x, top at y. */
const row = (n: number, x = 0, y = 0): Box[] => Array.from({ length: n }, (_, i) => ({ x0: x + i * 10, y0: y, x1: x + i * 10 + 10, y1: y + 20 }));
const overlaps = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
const centre = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const contains = (b: Box, p: { x: number; y: number }) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

describe('phraseMarkBox', () => {
  it('pads a match with nothing around it', () => {
    const chars = row(3);
    const mark = phraseMarkBox({ x0: 0, y0: 0, x1: 30, y1: 20 }, chars);
    const pad = PHRASE_PAD * 20;
    expect(mark).toEqual({ x0: -pad, y0: -pad, x1: 30 + pad, y1: 20 + pad });
  });

  it('stops short of the letters either side and the lines above and below, covering every own centre', () => {
    // Three lines whose boxes overlap (tight leading); the match is letters 3–5 of the middle one.
    const above = row(10, 0, -15);
    const line = row(10, 0, 0);
    const below = row(10, 0, 15);
    const chars = [...above, ...line, ...below];
    const own = line.slice(3, 6);
    const mark = phraseMarkBox({ x0: 30, y0: 0, x1: 60, y1: 20 }, chars);
    for (const c of chars) {
      if (own.includes(c)) expect(contains(mark, centre(c))).toBe(true);
      else expect(overlaps(mark, c), JSON.stringify(c)).toBe(false);
    }
    expect(mark.x0).toBeCloseTo(30 + NEIGHBOUR_GAP, 10);
    expect(mark.x1).toBeCloseTo(60 - NEIGHBOUR_GAP, 10);
  });

  it('leaves a letter kerned into the match under the mark rather than uncover the match', () => {
    const own = row(2, 10);
    const kerned = { x0: 2, y0: 0, x1: 16, y1: 20 }; // reaches past the first own centre (15)
    const mark = phraseMarkBox({ x0: 10, y0: 0, x1: 30, y1: 20 }, [kerned, ...own]);
    for (const c of own) expect(contains(mark, centre(c))).toBe(true);
    expect(overlaps(mark, kerned)).toBe(true);
  });

  it('reads a MuPDF quad as its upright box', () => {
    expect(quadToBox([10, 5, 40, 5, 10, 25, 40, 25])).toEqual({ x0: 10, y0: 5, x1: 40, y1: 25 });
  });
});
