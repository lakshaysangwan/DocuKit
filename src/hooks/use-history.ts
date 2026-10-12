import { useCallback, useMemo, useReducer } from 'react';

/**
 * Undo/redo for one value.
 *
 *     const h = useHistory<Stamp[]>([]);
 *     h.value                       // what to render
 *     h.set(next)                   // a change the user can undo
 *     h.set(next, { coalesce: 'nudge:abc' })   // repeated quickly → one undo step
 *     h.preview(next)               // while dragging: shown, but not a step yet
 *     h.set(final)                  // on pointer-up: the drag becomes one step
 *     h.cancelPreview()             // the drag was abandoned
 *     h.undo(); h.redo(); h.canUndo; h.canRedo
 *     h.reset(initial)              // new file: forget everything
 *
 * The reducer is pure and exported so it can be tested without React.
 */

/** How many steps are kept by default. */
export const HISTORY_LIMIT = 100;
/** Changes with the same `coalesce` key closer together than this are one step. */
export const COALESCE_WINDOW_MS = 1000;

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  /** A value being previewed (mid-drag). Shown instead of `present`; not a step. */
  draft: T | null;
  /** Key and time of the last committed change, for coalescing. */
  lastKey: string | null;
  lastAt: number;
}

export type HistoryAction<T> =
  | { type: 'set'; next: T | ((current: T) => T); coalesce?: string; at: number }
  | { type: 'preview'; next: T | ((current: T) => T) }
  | { type: 'cancel-preview' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; next: T };

export function initialHistory<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [], draft: null, lastKey: null, lastAt: 0 };
}

/** The value to show: the preview while there is one, otherwise the committed value. */
export function historyValue<T>(state: HistoryState<T>): T {
  return state.draft ?? state.present;
}

function resolve<T>(next: T | ((current: T) => T), current: T): T {
  return typeof next === 'function' ? (next as (current: T) => T)(current) : next;
}

export function historyReducer<T>(
  state: HistoryState<T>,
  action: HistoryAction<T>,
  limit: number = HISTORY_LIMIT,
): HistoryState<T> {
  switch (action.type) {
    case 'set': {
      const next = resolve(action.next, historyValue(state));
      if (next === state.present) {
        // Nothing changed (a drag that ended where it began): just drop the preview.
        return state.draft === null ? state : { ...state, draft: null };
      }
      const merge =
        action.coalesce !== undefined &&
        action.coalesce === state.lastKey &&
        action.at - state.lastAt <= COALESCE_WINDOW_MS &&
        state.past.length > 0;
      return {
        past: merge ? state.past : [...state.past, state.present].slice(-limit),
        present: next,
        future: [],
        draft: null,
        lastKey: action.coalesce ?? null,
        lastAt: action.at,
      };
    }
    case 'preview':
      return { ...state, draft: resolve(action.next, historyValue(state)) };
    case 'cancel-preview':
      return state.draft === null ? state : { ...state, draft: null };
    case 'undo': {
      if (state.past.length === 0) return state.draft === null ? state : { ...state, draft: null };
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
        draft: null,
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      return {
        past: [...state.past, state.present].slice(-limit),
        present: state.future[0],
        future: state.future.slice(1),
        draft: null,
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'reset':
      return initialHistory(action.next);
  }
}

export interface SetOptions {
  /**
   * Changes that share a key and arrive within a second of each other are one
   * undo step — for arrow-key nudges and typing in a number field.
   */
  coalesce?: string;
}

export interface UseHistoryResult<T> {
  /** What to render: the preview during a drag, otherwise the committed value. */
  value: T;
  /** The committed value, ignoring any preview. */
  committed: T;
  set: (next: T | ((current: T) => T), options?: SetOptions) => void;
  preview: (next: T | ((current: T) => T)) => void;
  cancelPreview: () => void;
  undo: () => void;
  redo: () => void;
  reset: (next: T) => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory<T>(initial: T, options: { limit?: number } = {}): UseHistoryResult<T> {
  const limit = options.limit ?? HISTORY_LIMIT;
  const [state, dispatch] = useReducer(
    (s: HistoryState<T>, a: HistoryAction<T>) => historyReducer(s, a, limit),
    initial,
    initialHistory,
  );

  const set = useCallback(
    (next: T | ((current: T) => T), opts: SetOptions = {}) =>
      dispatch({ type: 'set', next, coalesce: opts.coalesce, at: Date.now() }),
    [],
  );
  const preview = useCallback((next: T | ((current: T) => T)) => dispatch({ type: 'preview', next }), []);
  const cancelPreview = useCallback(() => dispatch({ type: 'cancel-preview' }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((next: T) => dispatch({ type: 'reset', next }), []);

  return useMemo(
    () => ({
      value: historyValue(state),
      committed: state.present,
      set,
      preview,
      cancelPreview,
      undo,
      redo,
      reset,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
    }),
    [state, set, preview, cancelPreview, undo, redo, reset],
  );
}
