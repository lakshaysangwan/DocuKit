/**
 * Where "Find & mark all" puts a mark: over the phrase, not the line it is on.
 *
 * MuPDF's text search gives, for each match, one box per line it runs over,
 * spanning exactly the matched characters (their advances, and the font's
 * ascent to descent). MuPDF's redaction then removes EVERY character whose box
 * the mark overlaps at all — so a mark padded by a third of a point takes the
 * neighbouring "i" with it, and on single-spaced text even the bare match box
 * reaches into the lines above and below.
 *
 * So each match box is padded a little, then pulled back from every character
 * that is not part of the match until it no longer overlaps it, as long as it
 * still contains the centre of every character that is. A character that
 * cannot be avoided that way (kerned into the match) is left under the mark:
 * this may take one letter too many, never one too few.
 *
 * Boxes are in MuPDF page space: axis-aligned, y down. Pure: no MuPDF here.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Padding around a match, as a fraction of its box's thinner side (the line's height for most text). */
export const PHRASE_PAD = 0.12;

/** Gap left between a mark and a character it must not touch, in page units (points). */
export const NEIGHBOUR_GAP = 0.05;

const centre = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

const overlaps = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

const inside = (b: Box, p: { x: number; y: number }) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

/** The smallest upright box around a MuPDF quad `[ulx, uly, urx, ury, llx, lly, lrx, lry]`. */
export function quadToBox(q: ArrayLike<number>): Box {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * The mark for one line's part of a match. `match` is MuPDF's box for it,
 * `chars` every character box on the page (the match's own included).
 */
export function phraseMarkBox(match: Box, chars: readonly Box[]): Box {
  const own = chars.filter((c) => inside(match, centre(c)));
  const centres = (own.length > 0 ? own : [match]).map(centre);
  const keep = {
    x0: Math.min(...centres.map((p) => p.x)),
    x1: Math.max(...centres.map((p) => p.x)),
    y0: Math.min(...centres.map((p) => p.y)),
    y1: Math.max(...centres.map((p) => p.y)),
  };
  const pad = PHRASE_PAD * Math.min(match.x1 - match.x0, match.y1 - match.y0);
  const mark: Box = { x0: match.x0 - pad, y0: match.y0 - pad, x1: match.x1 + pad, y1: match.y1 + pad };

  const others = chars.filter((c) => !own.includes(c));
  for (const other of others) {
    if (!overlaps(mark, other)) continue;
    // Each way of stepping clear of it, and what it costs; only those that keep every own centre.
    const width = mark.x1 - mark.x0;
    const height = mark.y1 - mark.y0;
    const moves: { cost: number; apply: () => void }[] = [];
    const left = other.x1 + NEIGHBOUR_GAP;
    if (left <= keep.x0) moves.push({ cost: (left - mark.x0) * height, apply: () => (mark.x0 = left) });
    const right = other.x0 - NEIGHBOUR_GAP;
    if (right >= keep.x1) moves.push({ cost: (mark.x1 - right) * height, apply: () => (mark.x1 = right) });
    const top = other.y1 + NEIGHBOUR_GAP;
    if (top <= keep.y0) moves.push({ cost: (top - mark.y0) * width, apply: () => (mark.y0 = top) });
    const bottom = other.y0 - NEIGHBOUR_GAP;
    if (bottom >= keep.y1) moves.push({ cost: (mark.y1 - bottom) * width, apply: () => (mark.y1 = bottom) });
    if (moves.length === 0) continue; // cannot avoid it without uncovering the match: it goes too
    moves.reduce((best, m) => (m.cost < best.cost ? m : best)).apply();
  }
  return mark;
}
