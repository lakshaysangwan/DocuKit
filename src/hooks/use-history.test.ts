import { describe, it, expect } from 'vitest';
import {
  COALESCE_WINDOW_MS,
  historyReducer,
  historyValue,
  initialHistory,
  type HistoryAction,
  type HistoryState,
} from './use-history';

function run<T>(start: T, actions: HistoryAction<T>[], limit?: number): HistoryState<T> {
  return actions.reduce((s, a) => historyReducer(s, a, limit), initialHistory(start));
}

const set = <T,>(next: T | ((c: T) => T), at = 0, coalesce?: string): HistoryAction<T> => ({
  type: 'set',
  next,
  at,
  coalesce,
});

describe('historyReducer', () => {
  it('starts with nothing to undo or redo', () => {
    const s = initialHistory('a');
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(historyValue(s)).toBe('a');
  });

  it('set pushes a step, undo and redo walk it', () => {
    let s = run('a', [set('b'), set('c')]);
    expect(s.present).toBe('c');
    expect(s.past).toEqual(['a', 'b']);

    s = historyReducer(s, { type: 'undo' });
    expect(s.present).toBe('b');
    expect(s.future).toEqual(['c']);

    s = historyReducer(s, { type: 'undo' });
    expect(s.present).toBe('a');
    // Nothing left: undo is a no-op, not an error.
    expect(historyReducer(s, { type: 'undo' })).toBe(s);

    s = historyReducer(s, { type: 'redo' });
    s = historyReducer(s, { type: 'redo' });
    expect(s.present).toBe('c');
    expect(historyReducer(s, { type: 'redo' })).toBe(s);
  });

  it('a new change after undo discards the redo branch', () => {
    const s = run('a', [set('b'), set('c'), { type: 'undo' }, set('d')]);
    expect(s.present).toBe('d');
    expect(s.past).toEqual(['a', 'b']);
    expect(s.future).toEqual([]);
  });

  it('accepts an updater function', () => {
    const s = run(1, [set((n: number) => n + 1), set((n: number) => n * 10)]);
    expect(s.present).toBe(20);
    expect(s.past).toEqual([1, 2]);
  });

  it('setting the same value is not a step', () => {
    const a = { n: 1 };
    const s = run(a, [set(a)]);
    expect(s.past).toEqual([]);
  });

  it('a preview is shown but is not a step until it is set', () => {
    let s = run('a', [{ type: 'preview', next: 'a1' }, { type: 'preview', next: 'a2' }]);
    expect(historyValue(s)).toBe('a2');
    expect(s.present).toBe('a');
    expect(s.past).toEqual([]);

    // Pointer-up: the whole drag is one step back to where it started.
    s = historyReducer(s, set('a3'));
    expect(s.draft).toBeNull();
    expect(s.present).toBe('a3');
    expect(s.past).toEqual(['a']);
    expect(historyReducer(s, { type: 'undo' }).present).toBe('a');
  });

  it('an updater during a preview starts from the previewed value', () => {
    const s = run(1, [{ type: 'preview', next: 5 }, set((n: number) => n + 1)]);
    expect(s.present).toBe(6);
    expect(s.past).toEqual([1]);
  });

  it('cancel-preview goes back to the committed value', () => {
    const s = run('a', [{ type: 'preview', next: 'x' }, { type: 'cancel-preview' }]);
    expect(historyValue(s)).toBe('a');
    expect(s.past).toEqual([]);
  });

  it('a drag that ends where it began leaves no step and no preview', () => {
    const a = { n: 1 };
    const s = run(a, [{ type: 'preview', next: { n: 2 } }, set(a)]);
    expect(s.draft).toBeNull();
    expect(s.past).toEqual([]);
  });

  it('undo during a preview drops the preview too', () => {
    const s = run('a', [set('b'), { type: 'preview', next: 'b1' }, { type: 'undo' }]);
    expect(historyValue(s)).toBe('a');
  });

  it('coalesces quick changes with the same key into one step', () => {
    const s = run(0, [set(1, 1000, 'nudge'), set(2, 1200, 'nudge'), set(3, 1900, 'nudge')]);
    expect(s.present).toBe(3);
    expect(s.past).toEqual([0]);
    expect(historyReducer(s, { type: 'undo' }).present).toBe(0);
  });

  it('does not coalesce across keys, or after the window has passed', () => {
    const otherKey = run(0, [set(1, 1000, 'x:a'), set(2, 1100, 'x:b')]);
    expect(otherKey.past).toEqual([0, 1]);

    const late = run(0, [set(1, 1000, 'nudge'), set(2, 1000 + COALESCE_WINDOW_MS + 1, 'nudge')]);
    expect(late.past).toEqual([0, 1]);

    const noKey = run(0, [set(1, 1000), set(2, 1001)]);
    expect(noKey.past).toEqual([0, 1]);
  });

  it('does not coalesce into a step that was undone to', () => {
    const s = run(0, [set(1, 1000, 'nudge'), { type: 'undo' }, { type: 'redo' }, set(2, 1100, 'nudge')]);
    expect(s.past).toEqual([0, 1]);
  });

  it('keeps at most `limit` steps', () => {
    const s = run(0, [set(1), set(2), set(3), set(4)], 2);
    expect(s.past).toEqual([2, 3]);
    expect(s.present).toBe(4);
  });

  it('reset forgets everything', () => {
    const s = run('a', [set('b'), { type: 'preview', next: 'c' }, { type: 'reset', next: 'z' }]);
    expect(s).toEqual(initialHistory('z'));
  });
});
