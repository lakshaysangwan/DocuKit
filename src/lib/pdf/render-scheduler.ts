/**
 * Render scheduler: every page raster on the main thread goes through one queue.
 *
 *   • ONE task runs at a time. pdf.js rendering is CPU-bound on the main thread,
 *     so two renders in parallel only make both late — and they could not share
 *     the scratch canvas.
 *   • Lower `priority` number runs first; equal priorities run in the order they
 *     were scheduled. The page the user is looking at is `PRIORITY_VISIBLE`, its
 *     neighbours `PRIORITY_NEAR`, everything else `PRIORITY_BACKGROUND`.
 *   • The scheduler never starts a task in the tick that scheduled it or in the
 *     tick the previous one finished, so input and paint get a turn between two
 *     renders. Visible work waits one macrotask; anything else waits for the
 *     browser to be idle (`requestIdleCallback`, with a timeout so it cannot
 *     starve, and a timer where the API is missing — Safari).
 *   • A task that is no longer wanted is cancelled: a queued one never starts, a
 *     running one has its `AbortSignal` fired. Scheduling with a `key` cancels
 *     the previous task with that key, which is how "the user zoomed again"
 *     drops the render for the old zoom.
 *
 * A cancelled task's promise rejects with `RenderCancelledError`
 * (`name === 'AbortError'`); test with `isRenderCancelled`.
 */

/** The page (or thumbnail) the user is looking at right now. */
export const PRIORITY_VISIBLE = 0;
/** Next to what is visible: likely to be needed within a scroll. */
export const PRIORITY_NEAR = 1;
/** Everything else; only ever runs in idle time. */
export const PRIORITY_BACKGROUND = 2;

/** Idle work is forced through after this long even if the browser never goes idle. */
export const IDLE_TIMEOUT_MS = 200;
/** Delay standing in for an idle period where `requestIdleCallback` does not exist. */
export const IDLE_FALLBACK_DELAY_MS = 16;

export class RenderCancelledError extends Error {
  constructor(message = 'Render cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isRenderCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export interface ScheduleOptions {
  /** Lower runs first. Defaults to `PRIORITY_BACKGROUND`. */
  priority?: number;
  /** Aborting this cancels the task, queued or running. */
  signal?: AbortSignal;
  /** Scheduling another task with the same key cancels this one as stale. */
  key?: string;
}

export interface ScheduledTask<T> {
  /** Settles with the task's result, or rejects (`RenderCancelledError` if cancelled). */
  readonly promise: Promise<T>;
  /** Drop the task. Safe to call at any time, any number of times. */
  cancel(): void;
  /** Move a queued task up or down the queue. No effect once it is running. */
  setPriority(priority: number): void;
}

export interface RenderScheduler {
  /**
   * Queue `run`. It receives a signal that fires if the task is cancelled while
   * running; a well-behaved task stops and rejects when it does.
   */
  schedule<T>(run: (signal: AbortSignal) => Promise<T>, options?: ScheduleOptions): ScheduledTask<T>;
  /** Number of tasks queued and not yet started. */
  readonly pending: number;
  /** True while a task is running. */
  readonly busy: boolean;
}

interface Entry {
  run: (signal: AbortSignal) => Promise<unknown>;
  priority: number;
  seq: number;
  key?: string;
  controller: AbortController;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  detachSignal?: () => void;
}

type IdleHandle = { kind: 'idle' | 'timer'; id: number | ReturnType<typeof setTimeout> };

export function createRenderScheduler(): RenderScheduler {
  const queue: Entry[] = [];
  const byKey = new Map<string, Entry>();
  let running: Entry | null = null;
  let seq = 0;
  /** The wake-up currently armed, and whether it is the fast (visible) kind. */
  let armed: { handle: IdleHandle; urgent: boolean } | null = null;

  function nextEntry(): Entry | undefined {
    let best: Entry | undefined;
    for (const e of queue) {
      if (!best || e.priority < best.priority || (e.priority === best.priority && e.seq < best.seq)) {
        best = e;
      }
    }
    return best;
  }

  function disarm() {
    if (!armed) return;
    const { handle } = armed;
    if (handle.kind === 'idle') globalThis.cancelIdleCallback?.(handle.id as number);
    else clearTimeout(handle.id as ReturnType<typeof setTimeout>);
    armed = null;
  }

  /** Make sure something will call `pump` — sooner if visible work is waiting. */
  function arm() {
    if (running) return;
    const next = nextEntry();
    if (!next) {
      disarm();
      return;
    }
    const urgent = next.priority <= PRIORITY_VISIBLE;
    if (armed && (armed.urgent || !urgent)) return;
    disarm();

    let handle: IdleHandle;
    if (urgent) {
      handle = { kind: 'timer', id: setTimeout(pump, 0) };
    } else if (typeof globalThis.requestIdleCallback === 'function') {
      handle = { kind: 'idle', id: globalThis.requestIdleCallback(pump, { timeout: IDLE_TIMEOUT_MS }) };
    } else {
      handle = { kind: 'timer', id: setTimeout(pump, IDLE_FALLBACK_DELAY_MS) };
    }
    armed = { handle, urgent };
  }

  function settle(entry: Entry, ok: boolean, value: unknown) {
    if (entry.settled) return;
    entry.settled = true;
    entry.detachSignal?.();
    if (entry.key !== undefined && byKey.get(entry.key) === entry) byKey.delete(entry.key);
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  function pump() {
    armed = null;
    if (running) return;
    const entry = nextEntry();
    if (!entry) return;
    queue.splice(queue.indexOf(entry), 1);
    running = entry;

    let work: Promise<unknown>;
    try {
      work = entry.run(entry.controller.signal);
    } catch (err) {
      work = Promise.reject(err);
    }
    work.then(
      (value) => settle(entry, true, value),
      (err) => settle(entry, false, err),
    ).finally(() => {
      running = null;
      arm();
    });
  }

  function cancel(entry: Entry) {
    if (entry.settled) return;
    const at = queue.indexOf(entry);
    if (at !== -1) queue.splice(at, 1);
    // A running task is told to stop; its promise is rejected now rather than
    // when it gets round to noticing, so nobody waits on abandoned work.
    entry.controller.abort();
    settle(entry, false, new RenderCancelledError());
    arm();
  }

  return {
    schedule<T>(run: (signal: AbortSignal) => Promise<T>, options: ScheduleOptions = {}): ScheduledTask<T> {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });

      const entry: Entry = {
        run,
        priority: options.priority ?? PRIORITY_BACKGROUND,
        seq: seq++,
        key: options.key,
        controller: new AbortController(),
        resolve: resolve as (value: unknown) => void,
        reject,
        settled: false,
      };

      const task: ScheduledTask<T> = {
        promise,
        cancel: () => cancel(entry),
        setPriority(priority: number) {
          if (entry.settled || entry === running) return;
          entry.priority = priority;
          arm();
        },
      };

      if (options.signal?.aborted) {
        entry.settled = true;
        reject(new RenderCancelledError());
        return task;
      }

      if (options.key !== undefined) {
        const stale = byKey.get(options.key);
        if (stale) cancel(stale);
        byKey.set(options.key, entry);
      }

      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => cancel(entry);
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detachSignal = () => signal.removeEventListener('abort', onAbort);
      }

      queue.push(entry);
      arm();
      return task;
    },
    get pending() {
      return queue.length;
    },
    get busy() {
      return running !== null;
    },
  };
}

/**
 * The scheduler every `PdfDocHandle` uses. One for the whole page, so "one
 * render at a time" holds across documents and the scratch canvas is never
 * needed twice.
 */
export const renderScheduler: RenderScheduler = createRenderScheduler();
