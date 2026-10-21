import { describe, expect, it } from 'vitest';
import {
  chosenPages,
  fileLetter,
  isPlainOrder,
  movePage,
  pagesFrom,
  pagesOfFile,
  parseMergeRange,
  rangeTextFor,
  regroupByFiles,
  removeFile,
  removePage,
  replaceFilePages,
  resetOrder,
  toSegments,
  type MergePage,
} from './merge-pages';

let n = 0;
const id = () => `p${++n}`;
/** "A1 B1 A2" → the pages, for reading tests in the visitor's terms. */
const show = (list: MergePage[]) =>
  list.map((p) => `${p.fileId}${p.pageIndex === null ? '*' : p.pageIndex + 1}`).join(' ');

const A = () => pagesOfFile('A', 3, id);
const B = () => pagesOfFile('B', 2, id);

describe('pageList operations', () => {
  it('adds every page of a file, or one placeholder while it is locked', () => {
    expect(show(A())).toBe('A1 A2 A3');
    expect(show(pagesOfFile('L', null, id))).toBe('L*');
  });

  it('moves a page across files', () => {
    const list = [...A(), ...B()];
    const b1 = list[3].id;
    const a2 = list[1].id;
    expect(show(movePage(list, b1, a2))).toBe('A1 B1 A2 A3 B2');
    expect(movePage(list, 'nope', a2)).toBe(list);
  });

  it('removes a page and a whole file', () => {
    const list = [...A(), ...B()];
    expect(show(removePage(list, list[1].id))).toBe('A1 A3 B1 B2');
    expect(show(removeFile(list, 'A'))).toBe('B1 B2');
  });

  it('replaces a file\'s pages at the position of its first page', () => {
    const [a1, a2, a3] = A();
    const [b1, b2] = B();
    const list = [b1, a2, b2, a1, a3];
    expect(show(replaceFilePages(list, 'A', pagesFrom('A', [0, 2], id)))).toBe('B1 A1 A3 B2');
    // A file with no pages left gets them at the end.
    expect(show(replaceFilePages([b1, b2], 'A', pagesFrom('A', [1], id)))).toBe('B1 B2 A2');
  });

  it('regroups by file order, keeping each file\'s own page order', () => {
    const [a1, a2, a3] = A();
    const [b1, b2] = B();
    const list = [b2, a3, b1, a1, a2];
    expect(show(regroupByFiles(list, ['A', 'B']))).toBe('A3 A1 A2 B2 B1');
    expect(show(regroupByFiles(list, ['B', 'A']))).toBe('B2 B1 A3 A1 A2');
  });

  it('resets to files in order, pages in page order, keeping only the chosen pages', () => {
    const [a1, , a3] = A();
    const [b1, b2] = B();
    expect(show(resetOrder([b2, a3, b1, a1], ['A', 'B']))).toBe('A1 A3 B1 B2');
  });
});

describe('range ⇄ pageList', () => {
  it('reads ranges strictly', () => {
    expect(parseMergeRange('', 5)).toEqual({ ok: true, pages: [0, 1, 2, 3, 4] });
    expect(parseMergeRange('1-3, 5', 5)).toEqual({ ok: true, pages: [0, 1, 2, 4] });
    expect(parseMergeRange('5, 1', 5)).toEqual({ ok: true, pages: [0, 4] });
    expect(parseMergeRange('2-last', 4)).toEqual({ ok: true, pages: [1, 2, 3] });
    expect(parseMergeRange('odd', 5)).toEqual({ ok: true, pages: [0, 2, 4] });
    expect(parseMergeRange('even, first', 4)).toEqual({ ok: true, pages: [0, 1, 3] });
  });

  it('rejects what it cannot read, with a reason', () => {
    for (const bad of ['abc', '0', '6', '3-1', '1-', '1-9', '2x', ',']) {
      const parsed = parseMergeRange(bad, 5);
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.error.length, bad).toBeGreaterThan(10);
    }
  });

  it('writes the range back from the grid', () => {
    const list = [...A(), ...B()];
    const after = removePage(list, list[1].id);
    expect(chosenPages(after, 'A')).toEqual([0, 2]);
    expect(rangeTextFor(after, 'A')).toBe('1, 3');
    expect(rangeTextFor(list, 'B')).toBe('1-2');
  });

  it('a typed range round-trips through the grid', () => {
    const list = [...A(), ...B()];
    const parsed = parseMergeRange('2-3', 3);
    if (!parsed.ok) throw new Error('should parse');
    const next = replaceFilePages(list, 'A', pagesFrom('A', parsed.pages, id));
    expect(show(next)).toBe('A2 A3 B1 B2');
    expect(rangeTextFor(next, 'A')).toBe('2-3');
  });
});

describe('segments for the worker', () => {
  it('turns runs of one file into one segment, in output order', () => {
    const [a1, a2, a3] = A();
    const [b1, b2] = B();
    expect(toSegments([a1, b1, a2, b2], ['A', 'B'])).toEqual([
      { file: 0, pages: [0] },
      { file: 1, pages: [0] },
      { file: 0, pages: [1] },
      { file: 1, pages: [1] },
    ]);
    expect(toSegments([a3, a1, b2, b1, a2], ['A', 'B'])).toEqual([
      { file: 0, pages: [2, 0] },
      { file: 1, pages: [1, 0] },
      { file: 0, pages: [1] },
    ]);
  });

  it('sends a locked file as "all pages"', () => {
    const [b1] = B();
    const locked = pagesOfFile('L', null, id);
    expect(toSegments([b1, ...locked], ['B', 'L'])).toEqual([
      { file: 0, pages: [0] },
      { file: 1, pages: null },
    ]);
  });

  it('knows the plain "whole files in order" case', () => {
    const counts = new Map<string, number | null>([['A', 3], ['B', 2]]);
    const list = [...A(), ...B()];
    expect(isPlainOrder(list, ['A', 'B'], counts)).toBe(true);
    expect(isPlainOrder(list, ['B', 'A'], counts)).toBe(false);
    expect(isPlainOrder(removePage(list, list[0].id), ['A', 'B'], counts)).toBe(false);
    expect(isPlainOrder(movePage(list, list[3].id, list[0].id), ['A', 'B'], counts)).toBe(false);
    const locked = new Map<string, number | null>([['A', 3], ['L', null]]);
    expect(isPlainOrder([...A(), ...pagesOfFile('L', null, id)], ['A', 'L'], locked)).toBe(true);
  });
});

describe('file letters', () => {
  it('runs A to Z, then AA', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(fileLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });
});
