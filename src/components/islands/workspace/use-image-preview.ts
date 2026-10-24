import { useCallback, useEffect, useRef, useState } from 'react';
import { workerPool } from '@/workers/worker-pool';
import { displayUrlFor } from '@/components/islands/workspace/load-image';
import type {
  CompressImageOptions,
  CompressImageStats,
  ConvertImageOptions,
  ConvertImageStats,
  WorkerRequest,
  WorkerResponse,
} from '@/types/worker-messages';

/**
 * The live preview of an image tool: the image shown, run through the same
 * worker op the real run uses with the current settings, before anything is
 * downloaded. Its bytes are kept, so when the run reaches this image with these
 * settings it reuses them — the "after" image on screen is then exactly the
 * file that downloads. Compress Image and Convert Image use it; `spec` says
 * which op and how to read its result.
 *
 *  - Live (`live`): each settled change — 250 ms after the last one — is
 *    processed. One job at a time; a change made meanwhile waits, and only the
 *    latest runs.
 *  - Otherwise nothing is processed until `request()` (AVIF, PNG, large images).
 *  - `options` null (e.g. Target size) or `paused` (a run is going or done): nothing.
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

/** How a tool's preview talks to the worker. */
export interface PreviewSpec<O, S> {
  /** Settings that give the same output give the same key. */
  key: (options: O) => string;
  message: (buffer: ArrayBuffer, options: O) => WorkerRequest;
  /** The stats and MIME type of a successful response, or null if it has none. */
  read: (response: Extract<WorkerResponse, { status: 'success' }>) => { stats: S; mime: string } | null;
}

export interface ImagePreviewResult<S> {
  key: string;
  itemId: string;
  blob: Blob;
  url: string;
  stats: S;
}

export type PreviewStatus = 'off' | 'waiting' | 'working' | 'ready' | 'error';

export interface ImagePreview<O, S> {
  status: PreviewStatus;
  /** What to show: the result for these settings or, while working, this image's last one. */
  shown: ImagePreviewResult<S> | null;
  /** `shown` is for the current settings. */
  current: boolean;
  error: string | null;
  /** Make the preview for the current image and settings now. */
  request: () => void;
  /** A finished result for this image and these options, for the run to reuse. */
  lookup: (itemId: string, options: O) => ImagePreviewResult<S> | undefined;
}

export const COMPRESS_PREVIEW: PreviewSpec<CompressImageOptions, CompressImageStats> = {
  key: (o) => `${o.format}|${o.mode}|${o.mode === 'quality' ? (o.quality ?? '') : (o.targetBytes ?? '')}`,
  message: (buffer, options) => ({ op: 'compress-image', buffer, options, progressPort: undefined as never }),
  read: (r) => (r.stats?.image ? { stats: r.stats.image, mime: r.stats.image.mime } : null),
};

export const CONVERT_PREVIEW: PreviewSpec<ConvertImageOptions, ConvertImageStats> = {
  key: (o) => `${o.format}|${o.quality ?? ''}`,
  message: (buffer, options) => ({
    op: 'convert-image',
    buffer,
    mimeType: '',
    options,
    progressPort: undefined as never,
  }),
  read: (r) => (r.stats?.convert ? { stats: r.stats.convert, mime: r.stats.convert.mime } : null),
};

const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError';

interface Job<O> {
  key: string;
  item: PreviewItem;
  options: O;
}

export function useImagePreview<O, S>({
  spec,
  item,
  options,
  live,
  paused,
}: {
  spec: PreviewSpec<O, S>;
  item: PreviewItem | null;
  options: O | null;
  live: boolean;
  paused: boolean;
}): ImagePreview<O, S> {
  const cache = useRef(new Map<string, ImagePreviewResult<S>>());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const inFlight = useRef<string | null>(null);
  const queued = useRef<Job<O> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastShown = useRef<ImagePreviewResult<S> | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;

  const keyOf = useCallback((itemId: string, o: O) => `${itemId}|${specRef.current.key(o)}`, []);
  const key = item && options ? keyOf(item.id, options) : null;

  const start = useCallback((job: Job<O>) => {
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
          message: specRef.current.message(buffer, job.options),
          transfer: [buffer],
          signal: ctrl.signal,
        });
        if (response.status === 'error') throw new Error(response.message || 'The preview could not be made.');
        if (response.status !== 'success' || ctrl.signal.aborted) return;
        const read = specRef.current.read(response);
        if (!read) return;
        const blob = new Blob([response.result], { type: read.mime });
        const url = await displayUrlFor(blob);
        if (ctrl.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        const result: ImagePreviewResult<S> = { key: job.key, itemId: job.item.id, blob, url, stats: read.stats };
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
    (job: Job<O>) => {
      if (cache.current.has(job.key) || inFlight.current === job.key) return;
      if (inFlight.current) queued.current = job;
      else start(job);
    },
    [start],
  );

  // Live: process each settled change.
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
  const lookup = useCallback((itemId: string, o: O) => cache.current.get(keyOf(itemId, o)), [keyOf]);

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
