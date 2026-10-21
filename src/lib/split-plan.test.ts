import { describe, expect, it } from 'vitest';
import { baseNameOf, checkEveryN, checkPages, checkRanges, describePages, planSplit } from './split-plan';

describe('checkPages', () => {
  it('reads pages, ranges and keywords, sorted without repeats', () => {
    expect(checkPages('3, 1-2, 2', 5)).toEqual({ ok: true, pages: [0, 1, 2] });
    expect(checkPages('odd', 5)).toEqual({ ok: true, pages: [0, 2, 4] });
    expect(checkPages('even', 5)).toEqual({ ok: true, pages: [1, 3] });
    expect(checkPages('last', 5)).toEqual({ ok: true, pages: [4] });
    expect(checkPages('first, 4-last', 5)).toEqual({ ok: true, pages: [0, 3, 4] });
    expect(checkPages(' 2 - 3 ', 5)).toEqual({ ok: true, pages: [1, 2] });
  });

  it('treats an empty field as an empty selection', () => {
    expect(checkPages('', 5)).toEqual({ ok: true, pages: [] });
    expect(checkPages(' , ', 5)).toEqual({ ok: true, pages: [] });
  });

  it('refuses what is not a page of this PDF instead of dropping it', () => {
    for (const text of ['7', '0', '1-9', '4-2', 'abc', '1-2, x']) {
      const r = checkPages(text, 5);
      expect(r.ok, text).toBe(false);
    }
    expect(checkPages('9', 5)).toMatchObject({ error: expect.stringContaining('There is no page 9') });
    expect(checkPages('4-2', 5)).toMatchObject({ error: expect.stringContaining('runs backwards') });
    expect(checkPages('even', 1)).toMatchObject({ ok: false });
  });
});

describe('checkRanges', () => {
  it('makes one range per comma-separated part, in the order typed', () => {
    expect(checkRanges('4-5, 1-2', 5)).toEqual({ ok: true, ranges: [[3, 4], [0, 1]] });
    expect(checkRanges('1-2,, 3', 5)).toEqual({ ok: true, ranges: [[0, 1], [2]] });
    expect(checkRanges('odd, last', 5)).toEqual({ ok: true, ranges: [[0, 2, 4], [4]] });
    expect(checkRanges('1-2, 8', 5).ok).toBe(false);
  });
});

describe('checkEveryN', () => {
  it('accepts whole numbers from 1', () => {
    expect(checkEveryN('2')).toEqual({ ok: true, n: 2 });
    for (const t of ['', '0', '-1', '1.5', 'two']) expect(checkEveryN(t).ok, t).toBe(false);
  });
});

describe('planSplit', () => {
  const base = { total: 5, baseName: 'doc' };
  it('Extract: one file of the chosen pages', () => {
    expect(planSplit({ ...base, mode: 'extract', pages: [0, 2] })).toEqual([{ name: 'doc-split.pdf', pages: [0, 2] }]);
    expect(planSplit({ ...base, mode: 'extract', pages: [] })).toEqual([]);
  });
  it('Remove: one file of the other pages', () => {
    expect(planSplit({ ...base, mode: 'remove', pages: [1, 3] })).toEqual([{ name: 'doc-split.pdf', pages: [0, 2, 4] }]);
    expect(planSplit({ ...base, mode: 'remove', pages: [0, 1, 2, 3, 4] })).toEqual([]);
  });
  it('Split by Range: a part per range', () => {
    expect(planSplit({ ...base, mode: 'ranges', ranges: [[0, 1], [4]] })).toEqual([
      { name: 'doc-part1.pdf', pages: [0, 1] },
      { name: 'doc-part2.pdf', pages: [4] },
    ]);
  });
  it('Split Every N: the last part may be shorter', () => {
    expect(planSplit({ ...base, mode: 'every-n', n: 2 }).map((o) => o.pages)).toEqual([[0, 1], [2, 3], [4]]);
    expect(planSplit({ ...base, mode: 'every-n', n: 9 }).map((o) => o.pages)).toEqual([[0, 1, 2, 3, 4]]);
  });
  it('Extract Each Page: a part per page', () => {
    expect(planSplit({ ...base, mode: 'each' }).map((o) => o.name)).toEqual([
      'doc-part1.pdf', 'doc-part2.pdf', 'doc-part3.pdf', 'doc-part4.pdf', 'doc-part5.pdf',
    ]);
  });
});

describe('names and descriptions', () => {
  it('strips only a trailing .pdf', () => {
    expect(baseNameOf('Report.PDF')).toBe('Report');
    expect(baseNameOf('a.pdf.pdf')).toBe('a.pdf');
  });
  it('describes pages with en dashes', () => {
    expect(describePages([0, 1, 2, 4])).toBe('1–3, 5');
  });
});
