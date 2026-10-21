import { useCallback, useEffect, useRef, useState } from 'react';
import { workerPool } from '@/workers/worker-pool';
import { previewOptionsFor, settingsKey, type CompressSettings } from '@/lib/pdf-compress-presets';
import type { ProbePageInfo, ProcessingStats, WorkerResponse } from '@/types/worker-messages';

/**
 * The live quality preview: one page, compressed with the chosen settings by
 * the same `compressPdf` the real run uses, before anything is downloaded.
 *
 *  1. A probe (pure pdf-lib, in the worker) cuts the page out as a one-page PDF
 *     and inventories every page's images. One probe per page, cached.
 *  2. Each settled change of settings sends that one-page PDF through the
 *     ordinary `compress-pdf` op. Settled: 250 ms after the last change. One
 *     job at a time; a change made meanwhile waits and only the latest runs.
 *     Results are cached per page and settings, a few of them.
 *  3. Changing page cancels the page's jobs (the worker running them is
 *     stopped). A full run pauses the preview and cancels what it was doing.
 *
 * Calls `workerPool.submit` directly rather than `useWorker`, whose `run`
 * cancels its previous job: here a short job is allowed to finish.
 *
 * With `auto` false — phones, engines that cannot draw in a worker, or a page
 * whose images are too large — nothing is compressed until `request()`.
 * Target size has no preview: its settings depend on the whole file.
 */

/** Wait this long after the last change before compressing. */
export const PREVIEW_DEBOUNCE_MS = 250;
/** Results kept, across pages and settings. */
const RESULT_CACHE = 8;
/** One-page PDFs kept. */
const PROBE_CACHE = 6;
/**
 * Above this many image pixels on a page (width × height summed over the
 * images compression may change), the preview waits to be asked for even
 * where it would otherwise follow every change: each update costs seconds.
 */
export const LIVE_PIXEL_BUDGET = 24_000_000;

export interface PreviewResult {
  key: string;
  pageIndex: number;
  /** The one page, compressed. */
  pdf: ArrayBuffer;
  stats: ProcessingStats;
}

export type PreviewStatus =
  | 'off' //       no file, or Target size
  | 'waiting' //   manual: press "Preview quality"
  | 'working' //   probing or compressing
  | 'ready'
  | 'error';

export interface CompressPreview {
  status: PreviewStatus;
  /** What to show: the result for these settings, or while working the page's last one. */
  shown: PreviewResult | null;
  /** True when `shown` is for the current settings. */
  current: boolean;
  /** Whether this page's preview follows changes by itself. */
  live: boolean;
  /** Every page's image inventory, once probed. */
  inventory: ProbePageInfo[] | null;
  /** Make the preview for the current page and settings now. */
  request: () => void;
}

interface Options {
  file: File | null;
  pageIndex: number;
  settings: CompressSettings;
  /** Follow changes by itself (desktop with drawing in workers). */
  auto: boolean;
  /** A full run is going, or done: do nothing. */
  paused: boolean;
  /** The probe chose a page to open on. */
  onPageChosen?: (pageIndex: number) => void;
}

const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError';

async function submit(message: Parameters<NonNullable<typeof workerPool>['submit']>[0]['message'], transfer: Transferable[], signal: AbortSignal) {
  if (!workerPool) throw new Error('This browser cannot run the preview.');
  const response: WorkerResponse = await workerPool.submit({ module: 'pdf', message, transfer, signal });
  if (response.status === 'error') throw new Error(response.message || 'The preview could not be made.');
  return response;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): Map<K, V> {
  const next = new Map(map);
  next.delete(key);
  next.set(key, value);
  while (next.size > limit) next.delete(next.keys().next().value as K);
  return next;
}

export function useCompressPreview({ file, pageIndex, settings, auto, paused, onPageChosen }: Options): CompressPreview {
  const [inventory, setInventory] = useState<{ file: File; pages: ProbePageInfo[] } | null>(null);
  const [probes, setProbes] = useState<{ file: File | null; map: Map<number, ArrayBuffer> }>({ file: null, map: new Map() });
  const [results, setResults] = useState<{ file: File | null; map: Map<string, PreviewResult> }>({ file: null, map: new Map() });
  const [requested, setRequested] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);

  const isTarget = settings.level === 'target';
  const key = `${pageIndex}:${settingsKey(settings)}`;
  const pages = inventory && inventory.file === file ? inventory.pages : null;
  const pagePdf = probes.file === file ? probes.map.get(pageIndex) : undefined;
  const live = auto && (pages?.[pageIndex]?.eligiblePixels ?? 0) <= LIVE_PIXEL_BUDGET;
  const chosen = useRef(onPageChosen);
  chosen.current = onPageChosen;

  // 1a. A new file: inventory it and cut out the page to open on.
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const response = await submit({ op: 'compress-probe', buffer, progressPort: undefined as never }, [buffer], controller.signal);
        if (response.status !== 'success-probe' || controller.signal.aborted) return;
        setInventory({ file, pages: response.pages });
        setProbes((prev) => ({
          file,
          map: remember(prev.file === file ? prev.map : new Map(), response.pageIndex, response.pagePdf, PROBE_CACHE),
        }));
        chosen.current?.(response.pageIndex);
      } catch (err) {
        if (!isAbort(err)) setFailed({ key: 'probe', message: (err as Error).message });
      }
    })();
    return () => controller.abort();
  }, [file]);

  // 1b. Any other page: cut it out when it is first shown. Leaving the page cancels it.
  const haveInventory = !!pages;
  const havePage = !!pagePdf;
  useEffect(() => {
    if (!file || !haveInventory || havePage || isTarget || paused) return;
    const controller = new AbortController();
    (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const response = await submit({ op: 'compress-probe', buffer, pageIndex, progressPort: undefined as never }, [buffer], controller.signal);
        if (response.status !== 'success-probe' || controller.signal.aborted) return;
        setProbes((prev) => ({
          file,
          map: remember(prev.file === file ? prev.map : new Map(), response.pageIndex, response.pagePdf, PROBE_CACHE),
        }));
      } catch (err) {
        if (!isAbort(err)) setFailed({ key: `probe:${pageIndex}`, message: (err as Error).message });
      }
    })();
    return () => controller.abort();
  }, [file, pageIndex, haveInventory, havePage, isTarget, paused]);

  // 2. Compressing: one job at a time, the latest change next.
  const pageJobs = useRef<AbortController | null>(null);
  const inFlight = useRef<string | null>(null);
  const next = useRef<{ key: string; pageIndex: number; settings: CompressSettings; pdf: ArrayBuffer } | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;

  const startJob = useCallback((job: { key: string; pageIndex: number; settings: CompressSettings; pdf: ArrayBuffer }) => {
    const controller = pageJobs.current ?? new AbortController();
    pageJobs.current = controller;
    inFlight.current = job.key;
    const forFile = fileRef.current;
    const buffer = job.pdf.slice(0);
    (async () => {
      try {
        const response = await submit(
          { op: 'compress-pdf', buffer, options: previewOptionsFor(job.settings), progressPort: undefined as never },
          [buffer],
          controller.signal,
        );
        if (response.status !== 'success' || controller.signal.aborted || fileRef.current !== forFile) return;
        const result: PreviewResult = { key: job.key, pageIndex: job.pageIndex, pdf: response.result, stats: response.stats ?? {} };
        setResults((prev) => ({ file: forFile, map: remember(prev.file === forFile ? prev.map : new Map(), job.key, result, RESULT_CACHE) }));
      } catch (err) {
        if (!isAbort(err)) setFailed({ key: job.key, message: (err as Error).message });
      } finally {
        if (inFlight.current === job.key) {
          inFlight.current = null;
          const queued = next.current;
          next.current = null;
          if (queued && !controller.signal.aborted && queued.key !== job.key) startJob(queued);
        }
      }
    })();
  }, []);

  /** Cancel whatever the preview is doing (a page change, a full run, a new file). */
  const cancelJobs = useCallback(() => {
    pageJobs.current?.abort();
    pageJobs.current = null;
    inFlight.current = null;
    next.current = null;
  }, []);

  useEffect(() => cancelJobs, [pageIndex, file, cancelJobs]);
  useEffect(() => {
    if (paused) cancelJobs();
  }, [paused, cancelJobs]);

  const cached = results.file === file ? results.map.get(key) : undefined;
  const wanted = live || requested === key;

  useEffect(() => {
    if (!pagePdf || isTarget || paused || cached || !wanted) return;
    const job = { key, pageIndex, settings, pdf: pagePdf };
    const timer = setTimeout(
      () => {
        if (inFlight.current === key) return;
        if (inFlight.current) next.current = job;
        else startJob(job);
      },
      live ? PREVIEW_DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [key, pageIndex, settings, pagePdf, isTarget, paused, cached, wanted, live, startJob]);

  const request = useCallback(() => {
    setFailed(null);
    setRequested(key);
  }, [key]);

  // What to show.
  let status: PreviewStatus;
  let shown: PreviewResult | null = null;
  if (!file || isTarget) status = 'off';
  else if (cached) {
    status = 'ready';
    shown = cached;
  } else if (failed && (failed.key === key || failed.key === 'probe' || failed.key === `probe:${pageIndex}`)) status = 'error';
  else if (!wanted) status = 'waiting';
  else {
    status = 'working';
    // While the new one is made, the page's latest result stays up (marked busy).
    if (live && results.file === file) {
      for (const r of results.map.values()) if (r.pageIndex === pageIndex) shown = r;
    }
  }
  if (paused && status === 'working') status = 'waiting';

  return {
    status,
    shown,
    current: !!cached,
    live,
    inventory: pages,
    request,
  };
}

