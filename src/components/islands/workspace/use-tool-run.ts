import { useCallback, useRef, useState } from 'react';
import { useWorker } from '@/hooks/use-worker';

/**
 * `ready`    waiting for the visitor (the action may be disabled, with a reason).
 * `running`  the job is in progress.
 * `done`     `result` is ready to download.
 * `error`    the job failed; `error` says why and the action can be tried again.
 */
export type ToolPhase = 'ready' | 'running' | 'done' | 'error';

type RunWorker = ReturnType<typeof useWorker>['run'];

export interface ToolRun<R> {
  phase: ToolPhase;
  /** The job's result while `phase === 'done'`, otherwise null. */
  result: R | null;
  /** Why the job failed while `phase === 'error'`, otherwise null. */
  error: string | null;
  /** 0–100, from the worker's progress messages. */
  progress: number;
  progressLabel: string;
  /**
   * Run the tool's job. `job` receives the worker `run` function (progress is
   * wired to this hook) and resolves with the result, or with null if it was
   * cancelled. A thrown error becomes the `error` phase.
   */
  start: (job: (run: RunWorker) => Promise<R | null>) => Promise<void>;
  /** Stop a running job and go back to `ready`. */
  cancel: () => void;
  /**
   * An input changed: drop the result (or the error) and go back to `ready`.
   * Call it from every change that makes the result stale, and from
   * "Make changes". Safe to call in any phase.
   */
  invalidate: () => void;
}

interface State<R> {
  phase: ToolPhase;
  result: R | null;
  error: string | null;
}

const READY = { phase: 'ready', result: null, error: null } as const;

/**
 * The state behind the single action slot: ready → running → done (or error),
 * and back to ready whenever an input changes.
 *
 *     const run = useToolRun<ArrayBuffer>();
 *     const apply = () => run.start(async (work) => {
 *       const res = await work('pdf', message, transfer);
 *       if (!res) return null;                           // cancelled
 *       if (res.status === 'error') throw new Error(res.message);
 *       return res.result;
 *     });
 */
export function useToolRun<R>(): ToolRun<R> {
  const worker = useWorker();
  const [state, setState] = useState<State<R>>(READY);
  // The phase as of the last change, readable from callbacks without re-creating them.
  const phase = useRef<ToolPhase>('ready');
  // Bumped whenever a run is superseded, so a late result is ignored.
  const generation = useRef(0);
  const { run: runWorker, cancel: cancelWorker } = worker;

  const commit = useCallback((next: State<R>) => {
    phase.current = next.phase;
    setState(next);
  }, []);

  const start = useCallback(
    async (job: (run: RunWorker) => Promise<R | null>) => {
      const mine = ++generation.current;
      commit({ phase: 'running', result: null, error: null });
      try {
        const result = await job(runWorker);
        if (generation.current !== mine) return;
        commit(result === null ? READY : { phase: 'done', result, error: null });
      } catch (err) {
        if (generation.current !== mine) return;
        commit({
          phase: 'error',
          result: null,
          error: err instanceof Error ? err.message : 'Something went wrong.',
        });
      }
    },
    [runWorker, commit],
  );

  const cancel = useCallback(() => {
    generation.current++;
    cancelWorker();
    commit(READY);
  }, [cancelWorker, commit]);

  const invalidate = useCallback(() => {
    if (phase.current === 'ready') return;
    if (phase.current === 'running') {
      generation.current++;
      cancelWorker();
    }
    commit(READY);
  }, [cancelWorker, commit]);

  return {
    phase: state.phase,
    result: state.result,
    error: state.error,
    progress: worker.progress,
    progressLabel: worker.progressLabel,
    start,
    cancel,
    invalidate,
  };
}
