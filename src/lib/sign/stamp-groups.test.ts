import { describe, expect, it } from 'vitest';
import { copyRectToPage, type PageSize } from './placement';
import { groupPages, groupSize, moveLinked, removeStamp, setGroupPages, unlinkStamp, type GroupedStamp } from './stamp-groups';

const LETTER: PageSize = { widthPt: 612, heightPt: 792 };
const LANDSCAPE: PageSize = { widthPt: 792, heightPt: 612 };
const A5: PageSize = { widthPt: 420, heightPt: 595 };
const SIZES = [LETTER, LANDSCAPE, LETTER, A5];
const sizeOf = (i: number) => SIZES[i];

const rect = { x: 0.1, y: 0.8, width: 0.3, height: 0.05 };
const one: GroupedStamp = { id: 'a', pageIndex: 0, rect, group: 'g', pristine: true };

let n = 0;
const newId = () => `id${++n}`;

describe('setGroupPages', () => {
  it('puts a copy on every listed page, in the place copyRectToPage gives', () => {
    const out = setGroupPages([one], 'a', [0, 1, 2, 3], sizeOf, newId);
    expect(groupPages(out, 'g')).toEqual([0, 1, 2, 3]);
    for (const s of out) {
      expect(s.group).toBe('g');
      expect(s.pristine).toBe(false);
      expect(s.rect).toEqual(s.pageIndex === 0 ? rect : copyRectToPage(rect, LETTER, SIZES[s.pageIndex]));
    }
  });

  it('removes copies from pages no longer listed and keeps other stamps', () => {
    const other: GroupedStamp = { id: 'z', pageIndex: 1, rect, group: 'other', pristine: false };
    const all = setGroupPages([one, other], 'a', [0, 1, 2, 3], sizeOf, newId);
    const out = setGroupPages(all, 'a', [0, 2], sizeOf, newId);
    expect(groupPages(out, 'g')).toEqual([0, 2]);
    expect(out.find((s) => s.id === 'z')).toEqual(other);
  });

  it('can move the group off the source page, and ignores an empty list', () => {
    const out = setGroupPages([one], 'a', [1, 3], sizeOf, newId);
    expect(groupPages(out, 'g')).toEqual([1, 3]);
    expect(out.some((s) => s.id === 'a')).toBe(false);
    expect(setGroupPages([one], 'a', [], sizeOf, newId)).toEqual([one]);
  });
});

describe('moveLinked', () => {
  it('moves every copy to the matching box on its own page', () => {
    const all = setGroupPages([one], 'a', [0, 1, 2, 3], sizeOf, newId);
    const onA5 = all.find((s) => s.pageIndex === 3)!;
    const moved = { x: 0.2, y: 0.5, width: 0.25, height: 0.06 };
    const out = moveLinked(all, onA5.id, moved, false, sizeOf);
    for (const s of out) {
      expect(s.rect).toEqual(s.pageIndex === 3 ? moved : copyRectToPage(moved, A5, SIZES[s.pageIndex]));
    }
  });

  it('leaves an unlinked copy alone', () => {
    const all = setGroupPages([one], 'a', [0, 1, 2], sizeOf, newId);
    const second = all.find((s) => s.pageIndex === 1)!;
    const split = unlinkStamp(all, second.id, 'solo');
    expect(groupSize(split, split[0])).toBe(2);
    const out = moveLinked(split, 'a', { x: 0.5, y: 0.5, width: 0.2, height: 0.05 }, false, sizeOf);
    expect(out.find((s) => s.id === second.id)!.rect).toEqual(second.rect);
    expect(out.find((s) => s.pageIndex === 2)!.rect.x).toBeCloseTo(0.5, 9);
  });
});

describe('removeStamp', () => {
  it('removes one copy, or all of them', () => {
    const all = setGroupPages([one], 'a', [0, 1, 2], sizeOf, newId);
    expect(groupPages(removeStamp(all, 'a', false), 'g')).toEqual([1, 2]);
    expect(removeStamp(all, 'a', true)).toEqual([]);
  });
});
