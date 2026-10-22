import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  BLANK,
  blankInsertPosition,
  blankSizeSource,
  duplicatePage,
  initialPages,
  insertBlank,
  isUnchanged,
  movePage,
  normaliseTurn,
  pruneSelection,
  removePages,
  rotatePages,
  selectRange,
  toReorderOptions,
  toggleSelected,
  turnedAspect,
  type OrganizePage,
} from './organize-pages';
import { organizePdf } from './organize-write';

function ids() {
  let n = 0;
  return () => `p${n++}`;
}

const five = () => initialPages(5, ids());
const sources = (pages: OrganizePage[]) => pages.map((p) => p.source);

describe('page list operations', () => {
  it('starts with every page once, in order, unturned', () => {
    const pages = five();
    expect(sources(pages)).toEqual([0, 1, 2, 3, 4]);
    expect(pages.every((p) => p.turn === 0)).toBe(true);
    expect(new Set(pages.map((p) => p.id)).size).toBe(5);
    expect(isUnchanged(pages, 5)).toBe(true);
  });

  it('normalises any multiple of 90', () => {
    expect([0, 90, 180, 270, 360, 450, -90, -180, -270, -360].map(normaliseTurn)).toEqual([
      0, 90, 180, 270, 0, 90, 270, 180, 90, 0,
    ]);
  });

  it('moves a page forwards and backwards', () => {
    const pages = five();
    expect(sources(movePage(pages, 'p0', 'p3'))).toEqual([1, 2, 3, 0, 4]);
    expect(sources(movePage(pages, 'p4', 'p1'))).toEqual([0, 4, 1, 2, 3]);
    expect(movePage(pages, 'p2', 'p2')).toBe(pages);
    expect(movePage(pages, 'nope', 'p2')).toBe(pages);
    expect(isUnchanged(movePage(pages, 'p0', 'p1'), 5)).toBe(false);
  });

  it('turns only the pages asked for, both ways, wrapping at a full turn', () => {
    let pages = five();
    pages = rotatePages(pages, new Set(['p1', 'p3']), 'right');
    expect(pages.map((p) => p.turn)).toEqual([0, 90, 0, 90, 0]);
    pages = rotatePages(pages, new Set(['p1']), 'left');
    pages = rotatePages(pages, new Set(['p0']), 'left');
    expect(pages.map((p) => p.turn)).toEqual([270, 0, 0, 90, 0]);
    for (let i = 0; i < 3; i++) pages = rotatePages(pages, new Set(['p3']), 'right');
    expect(pages[3].turn).toBe(0);
    expect(rotatePages(pages, new Set(), 'right')).toBe(pages);
  });

  it('removes pages', () => {
    expect(sources(removePages(five(), new Set(['p0', 'p4'])))).toEqual([1, 2, 3]);
  });

  it('duplicates a page right after itself, with its turn and its own id', () => {
    const pages = rotatePages(five(), new Set(['p2']), 'right');
    const next = duplicatePage(pages, 'p2', 'copy');
    expect(sources(next)).toEqual([0, 1, 2, 2, 3, 4]);
    expect(next[3]).toEqual({ id: 'copy', source: 2, turn: 90 });
    // The copy turns on its own.
    expect(rotatePages(next, new Set(['copy']), 'right').map((p) => p.turn)).toEqual([0, 0, 90, 180, 0, 0]);
  });

  it('inserts a blank page at a position, clamped', () => {
    const pages = five();
    expect(sources(insertBlank(pages, 1, 'b'))).toEqual([0, BLANK, 1, 2, 3, 4]);
    expect(sources(insertBlank(pages, 0, 'b'))).toEqual([BLANK, 0, 1, 2, 3, 4]);
    expect(sources(insertBlank(pages, 99, 'b'))).toEqual([0, 1, 2, 3, 4, BLANK]);
  });

  it('puts a new blank after the last selected page, or at the end', () => {
    const pages = five();
    expect(blankInsertPosition(pages, new Set())).toBe(5);
    expect(blankInsertPosition(pages, new Set(['p3', 'p1']))).toBe(4);
    expect(blankInsertPosition(movePage(pages, 'p4', 'p0'), new Set(['p4']))).toBe(1);
  });

  it('selects a range from the anchor, either direction, adding to the selection', () => {
    const pages = five();
    expect([...selectRange(pages, new Set(['p0']), 'p2', 'p4')].sort()).toEqual(['p0', 'p2', 'p3', 'p4']);
    expect([...selectRange(pages, new Set(), 'p3', 'p1')].sort()).toEqual(['p1', 'p2', 'p3']);
    expect([...selectRange(pages, new Set(), null, 'p1')]).toEqual(['p1']);
    expect([...toggleSelected(new Set(['p1']), 'p1')]).toEqual([]);
    expect([...toggleSelected(new Set(['p1']), 'p2')].sort()).toEqual(['p1', 'p2']);
    expect([...pruneSelection(removePages(pages, new Set(['p1'])), new Set(['p1', 'p2']))]).toEqual(['p2']);
  });

  it('turns the list into the worker job, position by position', () => {
    let pages = five();
    pages = movePage(pages, 'p4', 'p0');
    pages = duplicatePage(pages, 'p1', 'c');
    pages = insertBlank(pages, 2, 'b');
    pages = rotatePages(pages, new Set(['c', 'p4']), 'left');
    expect(toReorderOptions(pages)).toEqual({
      order: [4, 0, BLANK, 1, 1, 2, 3],
      rotations: [270, 0, 0, 0, 270, 0, 0],
    });
  });

  it('sizes a blank like the nearest real page before it, or the first page', () => {
    const pages = insertBlank(insertBlank(movePage(five(), 'p3', 'p0'), 0, 'a'), 3, 'b');
    expect(sources(pages)).toEqual([BLANK, 3, 0, BLANK, 1, 2, 4]);
    expect(blankSizeSource(pages, 0)).toBe(0);
    expect(blankSizeSource(pages, 3)).toBe(0);
    expect(blankSizeSource(insertBlank(five(), 3, 'x'), 3)).toBe(2);
  });

  it('swaps the shape on a quarter turn', () => {
    expect(turnedAspect(0.5, 0)).toBe(0.5);
    expect(turnedAspect(0.5, 90)).toBe(2);
    expect(turnedAspect(0.5, 180)).toBe(0.5);
    expect(turnedAspect(0.5, 270)).toBe(2);
  });
});

/** A file whose pages say which they are, sized and turned as given. */
async function makeSource(pages: { size: [number, number]; rotate?: number }[]): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach(({ size, rotate }, i) => {
    const page = doc.addPage(size);
    page.drawText(`Source ${i + 1}`, { x: 20, y: 20, size: 12, font });
    if (rotate) page.setRotation(degrees(rotate));
  });
  // Through bytes, as the worker gets it.
  return PDFDocument.load(await doc.save());
}

async function roundTrip(doc: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await doc.save());
}

describe('organizePdf (the writer)', () => {
  it('adds the turn to each page’s own /Rotate and normalises it', async () => {
    const src = await makeSource([
      { size: [612, 792] },
      { size: [612, 792], rotate: 90 },
      { size: [612, 792], rotate: 270 },
      { size: [612, 792], rotate: 180 },
    ]);
    const out = await roundTrip(await organizePdf(src, { order: [0, 1, 2, 3], rotations: [90, 90, 90, 0] }));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([90, 180, 0, 180]);
  });

  it('writes order, duplicates and blanks as listed, duplicates turning independently', async () => {
    const src = await makeSource([{ size: [612, 792] }, { size: [612, 792] }, { size: [612, 792] }]);
    const out = await roundTrip(
      await organizePdf(src, { order: [2, 0, 0, BLANK, 1], rotations: [0, 90, 270, 0, 180] }),
    );
    expect(out.getPageCount()).toBe(5);
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 270, 0, 180]);
    // The two copies of page 1 are separate page objects.
    expect(out.getPage(1).ref.toString()).not.toBe(out.getPage(2).ref.toString());
  });

  it('gives a blank the displayed size of the real page before it, or of the first page', async () => {
    const src = await makeSource([
      { size: [400, 600] },
      { size: [500, 700], rotate: 90 },
      { size: [800, 300] },
    ]);
    const out = await roundTrip(
      await organizePdf(src, { order: [BLANK, 1, BLANK, 2, BLANK], rotations: [0, 0, 90, 0, 0] }),
    );
    const sizes = out.getPages().map((p) => {
      const { width, height } = p.getSize();
      return [Math.round(width), Math.round(height)];
    });
    // First blank: the original's first page. After the /Rotate 90 page: it as
    // displayed (700 × 500), whatever turn the blank itself has. After page 3: 800 × 300.
    expect(sizes).toEqual([[400, 600], [500, 700], [700, 500], [800, 300], [800, 300]]);
    expect(out.getPage(2).getRotation().angle).toBe(90);
  });

  it('leaves a page’s own /Rotate alone when it is not turned', async () => {
    const src = await makeSource([{ size: [612, 792], rotate: 90 }]);
    const out = await roundTrip(await organizePdf(src, { order: [0], rotations: [0] }));
    expect(out.getPage(0).getRotation().angle).toBe(90);
  });
});
