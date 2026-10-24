import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Link2Off, X } from 'lucide-react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import MultiFileDownload, { useMultiFileDownload, type MultiFile } from '@/components/islands/shared/MultiFileDownload';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import ImageStage from '@/components/islands/workspace/ImageStage';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { displayUrlFor, loadImage, type LoadedImage } from '@/components/islands/workspace/load-image';
import { useMediaQuery } from '@/hooks/use-media-query';
import { downloadBlob } from '@/lib/download';
import { decodeToBitmap } from '@/lib/image-codec';
import { formatName, sniffImageMime, uniqueNames } from '@/lib/compress-image';
import {
  BACKGROUND_CSS,
  FIT_LABEL,
  MAX_PERCENT,
  MIN_PERCENT,
  RESIZE_QUALITY,
  backgroundFor,
  describeLayout,
  dragFocus,
  effectiveMode,
  keepsTransparency,
  outputMimeFor,
  outputSize,
  resizeLayout,
  resizedFileName,
  settingsProblem,
  type FitMode,
  type ResizeBackground,
  type ResizeLayout,
  type ResizeSettings,
  type SizeMode,
} from '@/lib/resize-image';
import { formatBytes, generateId, cn } from '@/lib/utils';
import OutputFrame from './OutputFrame';

/**
 * Resize Image, in the shared workspace.
 *
 * Before the run the stage shows the OUTPUT FRAME: the chosen width × height at
 * its true proportions, with the image drawn in it exactly where the chosen fit
 * mode puts it — from `resizeLayout`, the function the writer draws with. With
 * Cover, the image can be dragged in the frame to choose what is kept. After
 * the run the stage shows the resized file itself, and the facts beside it come
 * from that file.
 *
 * Several images: a strip above the stage chooses which is shown; every image
 * gets the same settings, and the results are handed over with
 * `MultiFileDownload`.
 */

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/heif'];
const NO_FILES: MultiFile[] = [];
const FIT_MODES: FitMode[] = ['fit', 'cover', 'stretch'];
const BACKGROUNDS: ResizeBackground[] = ['white', 'black', 'transparent'];
const BG_LABEL: Record<ResizeBackground, string> = { white: 'White', black: 'Black', transparent: 'Transparent' };
const FIT_NOTE: Record<FitMode, string> = {
  fit: 'The whole image, scaled to fit inside; the background fills the rest.',
  cover: 'The frame filled, keeping the proportions; what overflows is cropped.',
  stretch: 'The image stretched to the frame; its proportions change.',
};
const PERCENT_CHOICES = [25, 50, 75, 200];

interface Preset {
  label: string;
  w: number;
  h: number;
}
const PRESETS_KEY = 'docukit:resize-presets';

function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const SOCIAL_PRESETS: Preset[] = [
  { label: 'Instagram Post (1:1)', w: 1080, h: 1080 },
  { label: 'Instagram Story', w: 1080, h: 1920 },
  { label: 'Instagram Landscape', w: 1080, h: 566 },
  { label: 'Twitter/X Post', w: 1200, h: 675 },
  { label: 'Twitter/X Header', w: 1500, h: 500 },
  { label: 'LinkedIn Banner', w: 1584, h: 396 },
  { label: 'LinkedIn Post', w: 1200, h: 627 },
  { label: 'YouTube Thumbnail', w: 1280, h: 720 },
  { label: 'Facebook Cover', w: 851, h: 315 },
];

interface Item {
  id: string;
  file: File;
  info: LoadedImage | null;
  /** The real format, from the file's first bytes. */
  mime: string | null;
  failed: boolean;
}

interface Output {
  itemId: string;
  name: string;
  blob: Blob;
  url: string;
  mime: string;
  width: number;
  height: number;
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
}

interface RunResult {
  outputs: Output[];
  files: MultiFile[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const px = (w: number, h: number) => `${w} × ${h} px`;

const choice = (on: boolean) =>
  cn(
    'h-9 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-background)]',
  );

const field =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

/** A number field's value as a number; empty is NaN so it can be told apart from 0. */
const numberOf = (raw: string) => (raw.trim() === '' ? Number.NaN : Number(raw));

export default function ResizeImageTool() {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState(0);
  const [sizeMode, setSizeMode] = useState<SizeMode>('exact');
  const [width, setWidth] = useState(Number.NaN);
  const [height, setHeight] = useState(Number.NaN);
  const [percent, setPercent] = useState(50);
  const [lockAspect, setLockAspect] = useState(true);
  const [mode, setMode] = useState<FitMode>('fit');
  const [bgChoice, setBgChoice] = useState<ResizeBackground | null>(null);
  const [focus, setFocus] = useState({ x: 0.5, y: 0.5 });
  const [customPresets, setCustomPresets] = useState<Preset[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [step, setStep] = useState({ index: 0, count: 1 });
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const run = useToolRun<RunResult>();
  const { invalidate } = run;

  const active = items.length > 0;
  const batch = items.length > 1;
  const index = Math.min(selected, Math.max(0, items.length - 1));
  const item = items[index] ?? null;

  const settings = useMemo<ResizeSettings>(() => ({ sizeMode, width, height, percent }), [sizeMode, width, height, percent]);
  const fitMode = effectiveMode(settings, mode);

  useEffect(() => setCustomPresets(loadPresets()), []);

  /* ── Files ────────────────────────────────────────────────────────────── */

  const urls = useRef(new Map<string, string>());
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
    };
  }, []);

  // The first image of a new set gives the starting size (its own). It is set in
  // the same update as that image's size, and the fields are disabled until
  // then, so nothing typed early can be overwritten.
  const sizeFrom = useRef<string | null>(null);

  const read = useCallback((added: Item[]) => {
    for (const it of added) {
      it.file
        .slice(0, 64)
        .arrayBuffer()
        .then((head) => {
          const mime = sniffImageMime(new Uint8Array(head));
          setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, mime } : p)));
        })
        .catch(() => {});
      loadImage(it.file).then(
        (info) => {
          urls.current.set(it.id, info.url);
          setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, info } : p)));
          if (sizeFrom.current === it.id) {
            sizeFrom.current = null;
            setWidth(info.width);
            setHeight(info.height);
          }
        },
        () => setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, failed: true } : p))),
      );
    }
  }, []);

  const first = items[0]?.info;

  const drop = useCallback((gone: Item[]) => {
    for (const it of gone) {
      const url = urls.current.get(it.id);
      if (url) URL.revokeObjectURL(url);
      urls.current.delete(it.id);
    }
  }, []);

  const newItems = (files: File[]): Item[] =>
    files.map((file) => ({ id: generateId(), file, info: null, mime: null, failed: false }));

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      invalidate();
      const added = newItems(files);
      setItems((prev) => {
        if (prev.length === 0) {
          setSelected(0);
          sizeFrom.current = added[0].id;
        }
        return [...prev, ...added];
      });
      read(added);
    },
    [invalidate, read],
  );

  const replaceFile = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      invalidate();
      const added = newItems(files);
      sizeFrom.current = added[0].id;
      setItems((prev) => {
        drop(prev);
        return added;
      });
      setSelected(0);
      read(added);
    },
    [invalidate, read, drop],
  );

  const removeAll = useCallback(() => {
    invalidate();
    setItems((prev) => {
      drop(prev);
      return [];
    });
    setSelected(0);
    sizeFrom.current = null;
  }, [invalidate, drop]);

  const removeOne = useCallback(
    (id: string) => {
      invalidate();
      setItems((prev) => {
        drop(prev.filter((p) => p.id === id));
        const rest = prev.filter((p) => p.id !== id);
        // The image that was to give the starting size is gone: the next one gives it.
        if (sizeFrom.current === id) {
          const next = rest[0];
          sizeFrom.current = next && !next.info ? next.id : null;
          if (next?.info) {
            setWidth(next.info.width);
            setHeight(next.info.height);
          }
        }
        return rest;
      });
    },
    [invalidate, drop],
  );

  /** Wrap a setter so any change makes the result stale. */
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      invalidate();
      set(value);
    };

  /* ── Size ─────────────────────────────────────────────────────────────── */

  const ratioSource = item?.info ?? first ?? null;
  const updateWidth = (w: number) => {
    invalidate();
    setWidth(w);
    if (lockAspect && ratioSource && Number.isFinite(w) && w > 0) {
      setHeight(Math.max(1, Math.round((w / ratioSource.width) * ratioSource.height)));
    }
  };
  const updateHeight = (h: number) => {
    invalidate();
    setHeight(h);
    if (lockAspect && ratioSource && Number.isFinite(h) && h > 0) {
      setWidth(Math.max(1, Math.round((h / ratioSource.height) * ratioSource.width)));
    }
  };
  const toggleLock = () => {
    invalidate();
    const next = !lockAspect;
    setLockAspect(next);
    // Locking again snaps the height back to the image's proportions.
    if (next && ratioSource && Number.isFinite(width) && width > 0) {
      setHeight(Math.max(1, Math.round((width / ratioSource.width) * ratioSource.height)));
    }
  };
  const applyPreset = (w: number, h: number) => {
    invalidate();
    setSizeMode('exact');
    setWidth(w);
    setHeight(h);
    setLockAspect(false);
  };

  const persistPresets = useCallback((next: Preset[]) => {
    setCustomPresets(next);
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
    } catch {
      /* storage full or blocked: the presets still work until the page closes */
    }
  }, []);
  const validExact = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
  const saveCurrentPreset = () => {
    if (!validExact) return;
    const label = `${width}×${height}`;
    if (customPresets.some((p) => p.label === label)) {
      toast.info('Preset already saved');
      return;
    }
    persistPresets([...customPresets, { label, w: width, h: height }]);
    toast.success(`Saved preset ${label}`);
  };
  const deletePreset = (label: string) => persistPresets(customPresets.filter((p) => p.label !== label));

  /* ── What the shown image will become ─────────────────────────────────── */

  const loading = items.some((it) => !it.info && !it.failed);
  const anyFailed = items.find((it) => it.failed);
  const sources = items.flatMap((it) => (it.info ? [{ width: it.info.width, height: it.info.height }] : []));
  const problem = loading || anyFailed ? null : settingsProblem(settings, sources);
  const sizeInvalid = !!settingsProblem(settings, []); // the fields themselves, whatever the images

  const outMime = item ? outputMimeFor(item.mime ?? item.file.type) : 'image/jpeg';
  const defaultBg = (mime: string): ResizeBackground => (keepsTransparency(mime) ? 'transparent' : 'white');
  const bgFor = (mime: string) => backgroundFor(mime, bgChoice ?? defaultBg(mime));
  const background = bgFor(outMime);

  const layout: ResizeLayout | null =
    item?.info && !sizeInvalid
      ? (() => {
          const out = outputSize(item.info.width, item.info.height, settings);
          return resizeLayout({
            srcW: item.info.width,
            srcH: item.info.height,
            outW: out.width,
            outH: out.height,
            mode: fitMode,
            focusX: focus.x,
            focusY: focus.y,
          });
        })()
      : null;
  const cropping = !!layout && fitMode === 'cover' && (layout.cropX || layout.cropY);
  const upscale = items.some((it) => {
    if (!it.info || sizeInvalid) return false;
    const out = outputSize(it.info.width, it.info.height, settings);
    return out.width > it.info.width || out.height > it.info.height;
  });

  const pan = useCallback(
    (dx: number, dy: number) => {
      if (!layout) return;
      invalidate();
      setFocus((f) => dragFocus(layout, f, dx, dy));
    },
    [layout, invalidate],
  );

  /* ── The run ──────────────────────────────────────────────────────────── */

  const resize = useCallback(() => {
    if (!active || problem || loading || anyFailed) return;
    const list = items;
    const used = { settings, mode: fitMode, focusX: focus.x, focusY: focus.y };
    void run.start(async (work) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const outputs: Output[] = [];
      const cleanup = () => outputs.forEach((o) => URL.revokeObjectURL(o.url));
      for (const [i, it] of list.entries()) {
        setStep({ index: i, count: list.length });
        const size = outputSize(it.info!.width, it.info!.height, used.settings);
        const mime = outputMimeFor(it.mime ?? it.file.type);
        const buffer = await it.file.arrayBuffer();
        const response = await work(
          'image',
          {
            op: 'resize-image',
            buffer,
            mimeType: it.mime ?? it.file.type,
            options: {
              width: size.width,
              height: size.height,
              mode: used.mode,
              focusX: used.focusX,
              focusY: used.focusY,
              background: bgFor(mime),
            },
            progressPort: undefined as never,
          },
          [buffer],
        );
        if (!response) {
          cleanup();
          return null;
        }
        if (response.status === 'error') {
          cleanup();
          throw new Error(`${it.file.name} could not be resized: ${response.message}`);
        }
        if (response.status !== 'success') {
          cleanup();
          throw new Error(`${it.file.name} could not be resized.`);
        }
        // Everything said about the result is read back from the file.
        const realMime = sniffImageMime(new Uint8Array(response.result)) ?? mime;
        const blob = new Blob([response.result], { type: realMime });
        const bitmap = await decodeToBitmap(blob);
        const dims = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        outputs.push({
          itemId: it.id,
          name: resizedFileName(it.file.name, dims.width, dims.height, realMime),
          blob,
          url: await displayUrlFor(blob),
          mime: realMime,
          ...dims,
          originalBytes: it.file.size,
          originalWidth: it.info!.width,
          originalHeight: it.info!.height,
        });
      }
      const names = uniqueNames(outputs.map((o) => o.name));
      outputs.forEach((o, i) => (o.name = names[i]));
      return {
        outputs,
        files: outputs.map((o) => ({ name: o.name, blob: o.blob, width: o.width, height: o.height })),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, problem, loading, anyFailed, items, settings, fitMode, focus, run, bgChoice]);

  const result = run.result;
  useEffect(() => {
    if (!result) return;
    return () => {
      for (const o of result.outputs) URL.revokeObjectURL(o.url);
    };
  }, [result]);

  const resultFiles = result?.files ?? NO_FILES;
  const downloads = useMultiFileDownload({
    files: resultFiles,
    zipName: 'resized-images.zip',
    noun: { one: 'image', other: 'images' },
    folderStartIn: 'pictures',
  });

  const running = run.phase === 'running';
  const done = run.phase === 'done' && !!result;
  const output = done ? result!.outputs.find((o) => o.itemId === item?.id) ?? null : null;

  /* ── Stage ────────────────────────────────────────────────────────────── */

  let source: 'original' | 'frame' | 'output' = 'original';
  let stageStatus: string;
  if (!item || item.failed) stageStatus = item ? `${item.file.name} could not be read as an image.` : '';
  else if (!item.info) stageStatus = 'Reading the image…';
  else if (running) stageStatus = batch ? `Resizing ${step.index + 1} of ${step.count}…` : 'Resizing…';
  else if (output) {
    source = 'output';
    stageStatus = `${output.name}: ${px(output.width, output.height)} · ${formatName(output.mime)} · ${formatBytes(output.blob.size)}`;
  } else if (layout) {
    source = 'frame';
    stageStatus = `Output ${px(layout.width, layout.height)}, ${formatName(outMime)}. ${describeLayout(layout, fitMode, background)}${cropping ? ' Drag the image to choose what is kept.' : ''}`;
  } else {
    stageStatus = `Your original, ${px(item.info.width, item.info.height)}. Enter a size to see the output.`;
  }

  const frame =
    item?.info && layout && !output ? (
      <OutputFrame
        layout={layout}
        src={item.info.url}
        alt={`${item.file.name} as it will be resized`}
        mode={fitMode}
        background={background}
        fill={BACKGROUND_CSS[background]}
        onPan={cropping && !running ? pan : undefined}
      />
    ) : undefined;

  const stage = item ? (
    <ImageStage
      src={output ? output.url : (item.info?.url ?? null)}
      alt={output ? `Resized: ${output.name}` : `Original: ${item.file.name}`}
      naturalWidth={output ? output.width : layout ? layout.width : (item.info?.width ?? 0)}
      naturalHeight={output ? output.height : layout ? layout.height : (item.info?.height ?? 0)}
      content={frame}
      placeholder={item.failed ? 'This file could not be read as an image' : 'Reading the image…'}
      items={items.map((it) => ({ id: it.id, name: it.file.name, thumbSrc: it.info?.url ?? null }))}
      selected={index}
      onSelect={setSelected}
      footer={
        <p
          data-testid="stage-status"
          data-source={source}
          aria-live="polite"
          className="line-clamp-2 min-w-0 text-xs text-[var(--color-text-secondary)]"
        >
          {stageStatus}
        </p>
      }
    />
  ) : null;

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
  const note = 'text-xs leading-5 text-[var(--color-text-secondary)]';
  const label = 'mb-1 block text-xs text-[var(--color-text-secondary)]';
  const showBackground = sizeMode === 'exact' && (mode === 'fit' || keepsTransparency(outMime));

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={running}>
      <section className="flex flex-col gap-2" aria-labelledby="ri-size-heading">
        <h3 id="ri-size-heading" className={heading}>
          Size
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Size by">
          <button
            type="button"
            aria-pressed={sizeMode === 'exact'}
            data-testid="size-exact"
            onClick={() => change(setSizeMode)('exact')}
            className={choice(sizeMode === 'exact')}
          >
            Width and height
          </button>
          <button
            type="button"
            aria-pressed={sizeMode === 'percent'}
            data-testid="size-percent"
            onClick={() => change(setSizeMode)('percent')}
            className={choice(sizeMode === 'percent')}
          >
            Percentage
          </button>
        </div>

        {sizeMode === 'exact' ? (
          <>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor="ri-width" className={label}>
                  Width (px)
                </label>
                <input
                  id="ri-width"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  disabled={!first}
                  value={Number.isFinite(width) ? width : ''}
                  onChange={(e) => updateWidth(numberOf(e.target.value))}
                  className={field}
                />
              </div>
              <button
                type="button"
                onClick={toggleLock}
                aria-pressed={lockAspect}
                aria-label="Keep proportions"
                title={lockAspect ? 'Keep proportions: on' : 'Keep proportions: off'}
                data-testid="lock-aspect"
                className={cn(choice(lockAspect), 'mb-px flex w-10 shrink-0 items-center justify-center px-0')}
              >
                {lockAspect ? <Link2 className="size-4" aria-hidden="true" /> : <Link2Off className="size-4" aria-hidden="true" />}
              </button>
              <div className="min-w-0 flex-1">
                <label htmlFor="ri-height" className={label}>
                  Height (px)
                </label>
                <input
                  id="ri-height"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  disabled={!first}
                  value={Number.isFinite(height) ? height : ''}
                  onChange={(e) => updateHeight(numberOf(e.target.value))}
                  className={field}
                />
              </div>
            </div>
            <p className={note}>
              {lockAspect
                ? `Keep proportions is on: the other side follows${batch && ratioSource ? ' the image shown' : ''}.`
                : 'Keep proportions is off: the width and height are set separately.'}
              {batch ? ' Every image is resized to this size.' : ''}
            </p>
          </>
        ) : (
          <>
            <div>
              <label htmlFor="ri-percent" className={label}>
                Scale (%)
              </label>
              <input
                id="ri-percent"
                type="number"
                min={MIN_PERCENT}
                max={MAX_PERCENT}
                inputMode="decimal"
                value={Number.isFinite(percent) ? percent : ''}
                onChange={(e) => change(setPercent)(numberOf(e.target.value))}
                className={cn(field, 'w-32')}
              />
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Common percentages">
              {PERCENT_CHOICES.map((p) => (
                <button key={p} type="button" aria-pressed={percent === p} onClick={() => change(setPercent)(p)} className={choice(percent === p)}>
                  {p}%
                </button>
              ))}
            </div>
            <p className={note}>
              {batch ? 'Each image is scaled by this much of its own size' : 'The image is scaled by this much'}, keeping its
              proportions.
            </p>
          </>
        )}
        {upscale && (
          <p data-testid="upscale-warning" className="rounded-lg bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
            Larger than the original: enlarging an image cannot add detail, so it will look softer.
          </p>
        )}
      </section>

      {sizeMode === 'exact' && (
        <section className="flex flex-col gap-2" aria-labelledby="ri-fit-heading">
          <h3 id="ri-fit-heading" className={heading}>
            Fit
          </h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Fit">
            {FIT_MODES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                data-testid={`fit-${m}`}
                onClick={() => change(setMode)(m)}
                className={choice(mode === m)}
              >
                {FIT_LABEL[m]}
              </button>
            ))}
          </div>
          <p className={note}>{FIT_NOTE[mode]}</p>
          {mode === 'cover' && layout && (layout.cropX || layout.cropY) && (
            <div className="flex flex-col gap-1">
              <label htmlFor="ri-focus" className="text-xs text-[var(--color-text-secondary)]">
                {layout.cropX ? 'Crop position (left to right)' : 'Crop position (top to bottom)'}
              </label>
              <input
                id="ri-focus"
                type="range"
                min={0}
                max={100}
                data-testid="crop-position"
                value={Math.round((layout.cropX ? focus.x : focus.y) * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100;
                  invalidate();
                  setFocus((f) => (layout.cropX ? { ...f, x: v } : { ...f, y: v }));
                }}
                className="w-full accent-[var(--color-primary)]"
              />
              <p className={note}>Or drag the image in the frame.</p>
            </div>
          )}
        </section>
      )}

      {showBackground && (
        <section className="flex flex-col gap-2" aria-labelledby="ri-bg-heading">
          <h3 id="ri-bg-heading" className={heading}>
            Background
          </h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Background">
            {BACKGROUNDS.map((b) => (
              <button
                key={b}
                type="button"
                aria-pressed={background === b}
                disabled={b === 'transparent' && !keepsTransparency(outMime)}
                data-testid={`background-${b}`}
                onClick={() => change(setBgChoice)(b)}
                className={choice(background === b)}
              >
                {BG_LABEL[b]}
              </button>
            ))}
          </div>
          <p className={note}>
            {keepsTransparency(outMime)
              ? 'Fills the bars, and anything transparent in the image.'
              : `Fills the bars, and anything transparent in the image. ${formatName(outMime)} cannot be transparent.`}
          </p>
        </section>
      )}

      {layout && !done && (
        <section aria-labelledby="ri-preview-heading" className="flex flex-col gap-1">
          <h3 id="ri-preview-heading" className={heading}>
            Output
          </h3>
          <ul data-testid="preview-facts" className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
            <li>
              {batch ? `${item!.file.name}: ` : ''}
              {px(layout.width, layout.height)} · {formatName(outMime)}
            </li>
            <li>{describeLayout(layout, fitMode, background)}</li>
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="ri-presets-heading" data-testid="custom-presets">
        <div className="flex items-center justify-between gap-2">
          <h3 id="ri-presets-heading" className={heading}>
            Your presets
          </h3>
          <button
            type="button"
            onClick={saveCurrentPreset}
            data-testid="save-preset"
            disabled={!validExact || sizeMode !== 'exact'}
            className="h-8 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium hover:border-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {validExact ? `Save ${width}×${height}` : 'Save size'}
          </button>
        </div>
        {customPresets.length === 0 ? (
          <p className={note}>No saved presets yet. Save a size to reuse it later; it is kept in this browser.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {customPresets.map((p) => (
              <span key={p.label} data-testid="custom-preset" className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] pl-3 text-xs">
                <button type="button" onClick={() => applyPreset(p.w, p.h)} className="py-1.5 font-medium text-[var(--color-text-primary)]">
                  {p.label}
                </button>
                <button
                  type="button"
                  onClick={() => deletePreset(p.label)}
                  aria-label={`Delete preset ${p.label}`}
                  className="px-2 py-1.5 text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      <details className="rounded-lg border border-[var(--color-border)]">
        <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-[var(--color-text-primary)]">Social media presets</summary>
        <div className="grid grid-cols-1 gap-1 p-2">
          {SOCIAL_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.w, p.h)}
              className="rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--color-background)]"
            >
              <span className="font-medium text-[var(--color-text-primary)]">{p.label}</span>
              <span className="ml-2 text-[var(--color-text-secondary)]">
                {p.w}×{p.h}
              </span>
            </button>
          ))}
        </div>
      </details>

      {batch && (
        <section className="flex flex-col gap-2" aria-labelledby="ri-files-heading">
          <h3 id="ri-files-heading" className={heading}>
            Images ({items.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {items.map((it, i) => (
              <li key={it.id} data-testid="file-row" className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-current={i === index ? 'true' : undefined}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded px-1 py-1 text-left',
                    i === index ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]',
                  )}
                >
                  {it.file.name}
                </button>
                <span className="shrink-0 tabular-nums text-[var(--color-text-secondary)]">
                  {it.info ? px(it.info.width, it.info.height) : ''}
                </span>
                <button
                  type="button"
                  onClick={() => removeOne(it.id)}
                  aria-label={`Remove ${it.file.name}`}
                  data-testid="file-remove"
                  className="flex size-7 shrink-0 items-center justify-center rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DropZone accept={ACCEPTED} multiple onFiles={addFiles} compact compactLabel="Add images" hint="JPEG, PNG, WebP, AVIF, HEIC, GIF, BMP" />

      <p className={note}>
        Saved in the format of your image (JPEG, PNG, WebP or AVIF; GIF and BMP as PNG, HEIC as JPEG), lossy formats at
        quality {RESIZE_QUALITY}. A GIF is resized as a still image (its first frame). Only the pixels are saved: EXIF and
        other metadata (camera, location, date) are not copied, and a photo is kept the way up it is shown.
      </p>
    </div>
  );

  /* ── Result ───────────────────────────────────────────────────────────── */

  const totalAfter = result ? result.outputs.reduce((s, o) => s + o.blob.size, 0) : 0;

  const resultPanel =
    done && result ? (
      <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="result-panel">
        {output && (
          <section aria-labelledby="ri-facts-heading" className="flex flex-col gap-1.5">
            <h3 id="ri-facts-heading" className={heading} data-testid="facts-heading">
              {output.name}
            </h3>
            <ul data-testid="image-facts" className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
              <li data-testid="fact-size" className="font-medium text-[var(--color-text-primary)]">
                {px(output.width, output.height)} · {formatName(output.mime)} · {formatBytes(output.blob.size)}
              </li>
              <li data-testid="fact-original">
                Original: {px(output.originalWidth, output.originalHeight)} · {formatBytes(output.originalBytes)}
              </li>
            </ul>
          </section>
        )}

        {batch && (
          <section aria-labelledby="ri-batch-heading" className="flex flex-col gap-1.5">
            <h3 id="ri-batch-heading" className={heading}>
              {plural(result.outputs.length, 'image')} · {formatBytes(totalAfter)}
            </h3>
            <ul data-testid="batch-facts" className="flex flex-col gap-0.5 text-xs">
              {result.outputs.map((o, i) => (
                <li key={o.itemId}>
                  <button
                    type="button"
                    data-testid="batch-fact"
                    onClick={() => setSelected(i)}
                    aria-current={i === index ? 'true' : undefined}
                    className={cn(
                      'w-full rounded px-1 py-1 text-left',
                      i === index ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]',
                    )}
                  >
                    {o.name} · {px(o.width, o.height)} · {formatBytes(o.blob.size)}
                  </button>
                </li>
              ))}
            </ul>
            <MultiFileDownload
              files={resultFiles}
              zipName="resized-images.zip"
              noun={{ one: 'image', other: 'images' }}
              listLabel="Your resized images"
              folderStartIn="pictures"
              controller={downloads}
              hidePrimary
            />
          </section>
        )}

        {result.outputs.some((o) => o.blob.size > 500 * 1024) ? (
          <NextStep href="/compress-image/" label="Compress Image">
            File still large? Make it smaller with
          </NextStep>
        ) : (
          <NextStep href="/convert-image/" label="Convert Image">
            Need another format? Try
          </NextStep>
        )}
      </div>
    ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const actionLabel = batch ? `Resize ${items.length} images` : 'Resize image';
  const beside = wide ? 'on the right' : 'below';

  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (loading) prompt = batch ? 'Reading your images…' : 'Reading your image…';
  else if (anyFailed) {
    prompt = `${anyFailed.file.name} could not be read as an image. Remove it or choose another file.`;
    promptTone = 'error';
  } else if (running) prompt = batch ? 'Resizing your images…' : 'Resizing your image…';
  else if (run.phase === 'error') {
    prompt = 'The image could not be resized. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = batch ? 'Choose an image above to see it resized, then download them.' : 'This is the resized image. Download it, or make changes.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) {
    prompt = `Open Options to choose the size, then press ${actionLabel}.`;
  } else if (problem) {
    prompt = `Enter a new size ${beside}, or choose a preset; the frame shows what you will get.`;
  } else if (cropping) {
    prompt = `Drag the image in the frame to choose what is kept, then press ${actionLabel}.`;
  } else {
    prompt = `The frame shows the output at its real proportions. Adjust it ${beside}, then press ${actionLabel}.`;
  }

  let hint: string | undefined;
  if (layout) {
    hint =
      sizeMode === 'percent'
        ? batch
          ? `Saves each image at ${percent}% of its size.`
          : `Saves a ${px(layout.width, layout.height)} ${formatName(outMime)} (${percent}%).`
        : batch
          ? `Saves every image at ${px(layout.width, layout.height)}, ${FIT_LABEL[mode]}.`
          : `Saves a ${px(layout.width, layout.height)} ${formatName(outMime)}, ${FIT_LABEL[mode]}.`;
  }

  const disabledReason = loading
    ? 'Reading the image…'
    : anyFailed
      ? `${anyFailed.file.name} could not be read as an image`
      : problem;

  const progress = Math.round(((step.index + run.progress / 100) / Math.max(1, step.count)) * 100);

  let summary: string | undefined;
  if (result && !batch && result.outputs[0]) {
    const o = result.outputs[0];
    summary = `${o.name} · ${px(o.width, o.height)} · ${formatBytes(o.blob.size)}`;
  } else if (result) {
    summary = `${plural(result.outputs.length, 'image')} · ${formatBytes(totalAfter)}`;
  }

  const single = result && result.outputs.length === 1 ? result.outputs[0] : null;
  const download = single
    ? {
        label: 'Download',
        onDownload: () => downloadBlob(single.blob, single.name),
        ariaLabel: `Download ${single.name}`,
      }
    : {
        label: downloads.primaryLabel,
        onDownload: downloads.handlePrimary,
        ariaLabel: downloads.primaryAriaLabel,
        busyLabel: downloads.primaryBusyLabel,
        doneLabel: downloads.primaryDoneLabel,
      };

  return (
    <ToolWorkspace
      toolId="resize-image"
      active={active}
      empty={<DropZone accept={ACCEPTED} multiple onFiles={addFiles} hint="JPEG, PNG, WebP, AVIF, HEIC, GIF, BMP · single or batch" />}
      title={batch ? 'Resize these images' : 'Resize this image'}
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        batch ? (
          <WorkspaceFileBar files={items.map((it) => it.file)} noun="image" onAdd={addFiles} onRemove={removeAll} accept={ACCEPTED} disabled={running} />
        ) : item ? (
          <WorkspaceFileBar
            file={item.file}
            extra={item.info ? px(item.info.width, item.info.height) : undefined}
            onRemove={removeAll}
            onReplace={replaceFile}
            accept={ACCEPTED}
            disabled={running}
          />
        ) : null
      }
      stage={stage}
      controls={controls}
      result={resultPanel}
      action={
        <ActionBar
          phase={run.phase}
          label={actionLabel}
          runningLabel="Resizing…"
          onRun={resize}
          disabledReason={disabledReason}
          hint={hint}
          progress={progress}
          progressLabel={batch ? `Resizing ${step.index + 1} of ${step.count}` : run.progressLabel}
          onCancel={run.cancel}
          download={download}
          summary={summary}
          onEditAgain={invalidate}
          error={run.error}
        />
      }
    />
  );
}
