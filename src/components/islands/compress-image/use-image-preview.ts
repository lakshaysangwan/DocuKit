import { useCallback, useEffect, useRef, useState } from 'react';
import { workerPool } from '@/workers/worker-pool';
import { displayUrlFor } from '@/components/islands/workspace/load-image';
import type { CompressImageOptions, CompressImageStats, WorkerResponse } from '@/types/worker-messages';

/**
 * The quality preview of Compress Image: the image shown, compressed with the
 * current settings by the same `compressImage` the real run uses, before
 * anything is downloaded. Its bytes are kept, so when the run reaches this
 * image with these settings it reuses them — the "after" image on screen is
 * then exactly the file that downloads.
 *
 *  - Live (`live`): each settled change — 250 ms after the last one — is
 *    compressed. One job at a time; a change made meanwhile waits, and only the
 *    latest runs.
 *  - Otherwise nothing is compressed until `request()` (AVIF, PNG, large images).
 *  - `options` null (Target size) or `paused` (a run is going or done): nothing.
 *
 * Calls `workerPool.submit` directly rather than `useWorker`, whose `run`
 * cancels its previous job: here a short job is allowed to finish.
 */

export const PREVIEW_DEBOUNCE_MS = 250;
/** Results kept, across images and settings. */
const CACHE = 8;

export interface PreviewItem {
  id: string;
  file: File;
}

export interface ImagePreviewResult {
  key: string;
  itemId: string;
  blob: Blob;
  url: string;
  stats: CompressImageStats;
}

export type PreviewStatus = 'off' | 'waiting' | 'working' | 'ready' | 'error';

export interface ImagePreview {
  status: PreviewStatus;
  /** What to show: the result for these settings or, while working, this image's last one. */
  shown: ImagePreviewResult | null;
  /** `shown` is for the current settings. */
  current: boolean;
  error: string | null;
  /** Make the preview for the current image and settings now. */
  request: () => void;
  /** A finished result for this image and these options, for the run to reuse. */
  lookup: (itemId: string, options: CompressImageOptions) => ImagePreviewResult | undefined;
}

export const previewKey = (itemId: string, o: CompressImageOptions) =>
  `${itemId}|${o.format}|${o.mode}|${o.mode === 'quality' ? (o.quality ?? '') : (o.targetBytes ?? '')}`;

const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError';

interface Job {
  key: string;
  item: PreviewItem;
  options: CompressImageOptions;
}

export function useImagePreview({
  item,
  options,
  live,
  paused,
}: {
  item: PreviewItem | null;
  options: CompressImageOptions | null;
  live: boolean;
  paused: boolean;
}): ImagePreview {
  const cache = useRef(new Map<string, ImagePreviewResult>());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const inFlight = useRef<string | null>(null);
  const queued = useRef<Job | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastShown = useRef<ImagePreviewResult | null>(null);

  const key = item && options ? previewKey(item.id, options) : null;

  const start = useCallback((job: Job) => {
    if (!workerPool) return;
    const ctrl = controller.current ?? new AbortController();
    controller.current = ctrl;
    inFlight.current = job.key;
    bump();
    (async () => {
      try {
        const buffer = await job.item.file.arrayBuffer();
        const response: WorkerResponse = await workerPool!.submit({
          module: 'image',
          message: { op: 'compress-image', buffer, options: job.options, progressPort: undefined as never },
          transfer: [buffer],
          signal: ctrl.signal,
        });
        if (response.status === 'error') throw new Error(response.message || 'The preview could not be made.');
        if (response.status !== 'success' || !response.stats?.image || ctrl.signal.aborted) return;
        const blob = new Blob([response.result], { type: response.stats.image.mime });
        const url = await displayUrlFor(blob);
        if (ctrl.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        const result: ImagePreviewResult = {
          key: job.key,
          itemId: job.item.id,
          blob,
          url,
          stats: response.stats.image,
        };
        const map = cache.current;
        const old = map.get(job.key);
        if (old) URL.revokeObjectURL(old.url);
        map.delete(job.key);
        map.set(job.key, result);
        // Drop the oldest, never the one on screen.
        for (const [k, value] of map) {
          if (map.size <= CACHE) break;
          if (value === lastShown.current || k === job.key) continue;
          URL.revokeObjectURL(value.url);
          map.delete(k);
        }
      } catch (err) {
        if (!isAbort(err)) setFailed({ key: job.key, message: (err as Error).message });
      } finally {
        if (inFlight.current === job.key) {
          inFlight.current = null;
          const next = queued.current;
          queued.current = null;
          if (next && !ctrl.signal.aborted && !cache.current.has(next.key)) start(next);
        }
        bump();
      }
    })();
  }, []);

  const enqueue = useCallback(
    (job: Job) => {
      if (cache.current.has(job.key) || inFlight.current === job.key) return;
      if (inFlight.current) queued.current = job;
      else start(job);
    },
    [start],
  );

  // Live: compress each settled change.
  const itemRef = useRef(item);
  itemRef.current = item;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!key || !live || paused) return;
    if (cache.current.has(key)) return;
    const timer = setTimeout(() => {
      const it = itemRef.current;
      const op = optionsRef.current;
      if (it && op) enqueue({ key, item: it, options: op });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, live, paused, enqueue]);

  // Asked for by the button.
  useEffect(() => {
    if (!requested || requested !== key || paused) return;
    const it = itemRef.current;
    const op = optionsRef.current;
    if (it && op) enqueue({ key: requested, item: it, options: op });
  }, [requested, key, paused, enqueue]);

  // A run cancels the preview's job; so does leaving.
  useEffect(() => {
    if (!paused) return;
    controller.current?.abort();
    controller.current = null;
    inFlight.current = null;
    queued.current = null;
  }, [paused]);
  useEffect(
    () => () => {
      controller.current?.abort();
      for (const r of cache.current.values()) URL.revokeObjectURL(r.url);
      cache.current.clear();
    },
    [],
  );

  const request = useCallback(() => setRequested(key), [key]);
  const lookup = useCallback(
    (itemId: string, o: CompressImageOptions) => cache.current.get(previewKey(itemId, o)),
    [],
  );

  const exact = key ? cache.current.get(key) : undefined;
  const stale = lastShown.current && item && lastShown.current.itemId === item.id ? lastShown.current : null;
  if (exact) lastShown.current = exact;

  let status: PreviewStatus;
  if (!key || paused) status = 'off';
  else if (exact) status = 'ready';
  else if (failed && failed.key === key) status = 'error';
  else if (inFlight.current || queued.current || live) status = 'working';
  else status = 'waiting';
  const shown = status === 'ready' ? exact! : status === 'working' ? stale : null;

  return {
    status,
    shown,
    current: !!exact,
    error: failed && failed.key === key ? failed.message : null,
    request,
    lookup,
  };
}
