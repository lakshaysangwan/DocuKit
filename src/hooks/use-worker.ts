import { useState, useCallback, useRef } from 'react';
import { workerPool, type JobOptions, type WorkerModule } from '../workers/worker-pool';
import type { WorkerRequest, WorkerResponse, ProgressMessage } from '../types/worker-messages';

interface UseWorkerState {
  isRunning: boolean;
  progress: number;
  progressLabel: string;
  error: string | null;
}

interface UseWorkerResult extends UseWorkerState {
  run: (
    module: WorkerModule,
    message: WorkerRequest,
    transfer?: Transferable[]
  ) => Promise<WorkerResponse | null>;
  cancel: () => void;
  reset: () => void;
}

export function useWorker(onProgress?: (msg: ProgressMessage) => void): UseWorkerResult {
  const [state, setState] = useState<UseWorkerState>({
    isRunning: false,
    progress: 0,
    progressLabel: '',
    error: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async (
    module: WorkerModule,
    message: WorkerRequest,
    transfer: Transferable[] = []
  ): Promise<WorkerResponse | null> => {
    if (!workerPool) {
      setState(s => ({ ...s, error: 'Worker pool not available' }));
      return null;
    }

    // Cancel any previous job
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setState({ isRunning: true, progress: 0, progressLabel: '', error: null });

    const options: JobOptions = {
      module,
      message,
      transfer,
      signal: controller.signal,
      onProgress: (msg: ProgressMessage) => {
        setState(s => ({ ...s, progress: msg.percent, progressLabel: msg.label ?? '' }));
        onProgress?.(msg);
      },
    };

    try {
      const response = await workerPool.submit(options);
      if (response.status === 'error') {
        setState(s => ({ ...s, isRunning: false, error: response.message }));
      } else {
        setState(s => ({ ...s, isRunning: false, progress: 100 }));
      }
      return response;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setState(s => ({ ...s, isRunning: false, error: null }));
        return null;
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setState(s => ({ ...s, isRunning: false, error: msg }));
      return null;
    }
  }, [onProgress]);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setState(s => ({ ...s, isRunning: false }));
  }, []);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    setState({ isRunning: false, progress: 0, progressLabel: '', error: null });
  }, []);

  return { ...state, run, cancel, reset };
}
