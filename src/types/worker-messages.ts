import type { WatermarkWriteOptions } from '../lib/watermark-write';
import type { PageGeometry } from '../lib/pdf/page-geometry';
import type { PageNumberPageTarget, PageNumberWriteOptions } from '../lib/page-number-write';
// ─── Request types (main thread → worker) ───────────────────────────────────

export type MergeOptions = {
  insertBlankPages?: boolean;
  /**
   * Route the merge through MuPDF, which grafts pages with their outline
   * entries and internal link targets intact. Costs a much heavier WASM load
   * than the default pdf-lib path, so it is opt-in.
   */
  preserveBookmarks?: boolean;
  /**
   * Optional per-file page selection (0-indexed), aligned to the `buffers`
   * array. `undefined`/`null` for a file means include all of its pages.
   */
  pageSelections?: (number[] | null)[];
  /**
   * The merged PDF's pages in output order, as runs of consecutive output pages
   * from one file: `file` indexes `buffers`, `pages` are 0-based source pages in
   * the order they go out (`null` = every page of that file, for a file whose
   * page count was unknown when the merge was asked for). When given it
   * replaces `pageSelections`, and the same file may appear in several runs.
   * "Insert blank pages" then puts a blank only where the source file changes.
   */
  segments?: { file: number; pages: number[] | null }[];
  /**
   * Per-file password for encrypted inputs, aligned to `buffers`. A `null`
   * entry for an encrypted file makes the merge fail with a message naming it.
   */
  passwords?: (string | null)[];
  /** Per-file display names, aligned to `buffers`, used only in error text. */
  fileNames?: string[];
};

export type SplitOptions = {
  mode: 'extract' | 'ranges' | 'every-n' | 'each' | 'remove';
  pages?: number[];       // 0-indexed for 'extract' and 'remove'
  ranges?: number[][];    // for 'ranges'
  n?: number;             // for 'every-n'
};

export type CompressPdfOptions = {
  level: 'low' | 'medium' | 'high' | 'custom';
  dpi?: number;
  jpegQuality?: number;   // 1-100
  grayscale?: boolean;
  stripFonts?: boolean;
  /** Linear scale applied to embedded images (0–1). Overrides the DPI-derived scale. */
  imageScale?: number;
  /**
   * Target-size mode: fit the output under this many bytes, keeping as much
   * quality as will fit. When set, the other options are ignored.
   */
  targetBytes?: number;
  /**
   * Also return what was done to each image (`ProcessingStats.images`) and the
   * settings the pass used (`ProcessingStats.applied`), for the facts shown
   * beside the compare view.
   */
  report?: boolean;
  /**
   * A one-page quality preview: return what the pass made even when it is not
   * smaller, so the page shows exactly what the pass does to its images.
   */
  preview?: boolean;
};

/** The settings a compression pass actually used. */
export interface CompressApplied {
  /** True when no image was re-encoded by design (Low, or the lossless target step). */
  lossless: boolean;
  /** JPEG quality, 1–100, images were written at (meaningless when `lossless`). */
  jpegQuality: number;
  /** Linear factor applied to each image's width and height (1 = unchanged). */
  imageScale: number;
  grayscale: boolean;
  stripFonts: boolean;
  /** Target-size mode: the step chosen (0 = lossless) and the number of steps. */
  ladderStep?: number;
  ladderSteps?: number;
  /** Target-size mode: the limit, in bytes. */
  targetBytes?: number;
}

/** Why an image was left exactly as it was. */
export type ImageKeptReason = 'masked' | 'unsupported' | 'small' | 'not-smaller' | 'quality-90-plus' | 'failed';

/** What a compression pass did with one image XObject. */
export interface CompressImageOutcome {
  /** Zero-based pages whose resources draw this image (directly or through a form). */
  pages: number[];
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
  /** Encoded stream length before and after. Equal when kept. */
  bytesBefore: number;
  bytesAfter: number;
  action: 'recompressed' | 'kept';
  reason?: ImageKeptReason;
}

/** One page of the per-page image inventory a probe returns. */
export interface ProbePageInfo {
  pageIndex: number;
  /** Image XObjects the page draws. */
  images: number;
  /** Of those, the ones the lossy pass may re-encode. */
  eligible: number;
  /** Encoded bytes of the eligible images. */
  eligibleBytes: number;
  /** Width × height summed over the eligible images. */
  eligiblePixels: number;
}

export type ReorderOptions = {
  // Source page index for each output position. -1 inserts a blank page.
  // A source index may repeat — that duplicates the page.
  order: number[];
  // Rotation per *output position*, parallel to `order`. Positional rather than
  // keyed by source index so two copies of one page can rotate independently.
  // It is added to the page's own /Rotate (see lib/organize-write.ts).
  rotations: (0 | 90 | 180 | 270)[];
};

export type SignVisualOptions = {
  annotations: VisualAnnotation[];
};

export type VisualAnnotation = {
  type: 'signature' | 'text' | 'date' | 'checkmark' | 'initials';
  pageIndex: number;
  x: number;    // points from left
  y: number;    // points from bottom (pdf-lib coordinate system)
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  imageDataUrl?: string;  // for signature/initials
  text?: string;          // for text/date
  fontSize?: number;
  color?: string;
};

export type EncryptOptions = {
  userPassword: string;
  ownerPassword?: string;
  permissions?: {
    print?: boolean;
    copyContents?: boolean;
    modifyContents?: boolean;
    fillForms?: boolean;
    annotations?: boolean;
    assemble?: boolean;
  };
};

/**
 * Watermark PDF. Where the watermark goes is worked out by `layoutWatermark`
 * (lib/watermark-layout.ts) from these options and each page's geometry — the
 * same call the preview makes — so the worker is told the geometry pdf.js
 * reported for every page it writes on, not left to guess it.
 */
export type WatermarkOptions = Omit<WatermarkWriteOptions, 'imageBytes'> & {
  /** Image watermark: PNG or JPEG bytes, exactly as previewed. */
  imageBytes?: ArrayBuffer;
  /** The pages to watermark, each with the geometry it was previewed on. */
  pages: { pageIndex: number; geometry: PageGeometry }[];
};

/** Add Page Numbers: the options the preview was drawn with, and every page's displayed geometry. */
export type PageNumberOptions = PageNumberWriteOptions & {
  pages: PageNumberPageTarget[];
};

export type CropOptions = {
  /** Inward from the VISUAL top, right, bottom and left of each page as displayed, in points. */
  margins: { top: number; right: number; bottom: number; left: number };
  /** The pages to crop, each with the geometry pdf.js displayed it with (CropBox mode; Flatten runs on the main thread). */
  pages: { pageIndex: number; geometry: PageGeometry }[];
};

export type PdfToImageOptions = {
  format: 'png' | 'jpeg' | 'webp' | 'avif';
  dpi: number;
  quality?: number;
  pages: number[];  // 0-indexed
};

export type ImagesToPdfOptions = {
  pageSize: 'fit' | 'a4' | 'letter' | 'legal' | 'custom';
  customWidth?: number;   // points
  customHeight?: number;  // points
  placement: 'center' | 'stretch' | 'fit' | 'cover';  // 'center' is the same as 'fit'
  /** Fixed page sizes only. 'auto' (the default) turns each page to match its image. */
  orientation?: 'auto' | 'portrait' | 'landscape';
  margins: { top: number; right: number; bottom: number; left: number };  // points; none on 'fit' pages
  backgroundColor?: string;
};

export type CompressImageFormat = 'jpeg' | 'webp' | 'png' | 'avif';

export type CompressImageOptions = {
  format: CompressImageFormat;
  mode: 'quality' | 'target-size';
  /** 1–100, quality mode. Ignored for PNG, which is lossless. */
  quality?: number;
  /** Target size mode: the most bytes the output may have. */
  targetBytes?: number;
};

/** What a Compress Image run actually produced, for the facts shown beside the compare view. */
export interface CompressImageStats {
  /** MIME type of the bytes returned — the real format, whatever was asked for. */
  mime: string;
  /** Pixel size of the output (always the input's: nothing is resized). */
  width: number;
  height: number;
  /** The format that was encoded. With `returnedOriginal` the bytes are not this. */
  encodedFormat: CompressImageFormat;
  /** Quality of that encode; null for PNG (lossless). */
  encodedQuality: number | null;
  /** Size of that encode, in bytes. */
  encodedBytes: number;
  /** The encode was not smaller, so the input's own bytes came back unchanged. */
  returnedOriginal: boolean;
  /** The input had transparent pixels and was flattened onto white (JPEG has no transparency). */
  flattenedOnWhite: boolean;
  /** Target size mode: the limit and whether the returned bytes are within it. */
  target?: { bytes: number; met: boolean };
}

/** Resize Image: the output frame and where the image goes in it (see `lib/resize-image.ts`). */
export type ResizeImageOptions = {
  /** Output size in pixels. */
  width: number;
  height: number;
  mode: 'fit' | 'cover' | 'stretch';
  /** Cover: which part is kept where the image overflows, 0–1 per axis. */
  focusX?: number;
  focusY?: number;
  /** Behind the image: the Fit bars and any transparent pixels. Transparent becomes white for JPEG. */
  background: 'white' | 'black' | 'transparent';
};

/** Convert Image: the four formats it can write. Quality applies to the lossy three; PNG ignores it. */
export type ConvertImageOptions = {
  format: CompressImageFormat;
  quality?: number;
};

/** What a Convert Image run actually produced, read from the bytes it returns. */
export interface ConvertImageStats {
  /** MIME type of the bytes returned, sniffed from them. */
  mime: string;
  /** Pixel size of the output: the input's as shown (EXIF orientation applied). */
  width: number;
  height: number;
  /** Quality of the encode; null for PNG (lossless). */
  quality: number | null;
  /** The input had transparent pixels. */
  hadTransparency: boolean;
  /** Those were composited onto white, because the output (JPEG) cannot store them. */
  flattenedOnWhite: boolean;
  /** The input's real format, sniffed from its bytes; null when unknown. */
  inputMime: string | null;
}

export type CropRotateImageOptions = {
  crop?: { x: number; y: number; width: number; height: number };
  rotate?: number;    // degrees
  flipH?: boolean;
  flipV?: boolean;
};

// ─── Worker Request union ────────────────────────────────────────────────────

export type WorkerRequest =
  | { op: 'merge'; buffers: ArrayBuffer[]; options: MergeOptions; progressPort: MessagePort }
  | { op: 'split'; buffer: ArrayBuffer; options: SplitOptions; progressPort: MessagePort }
  | { op: 'compress-pdf'; buffer: ArrayBuffer; options: CompressPdfOptions; progressPort: MessagePort }
  /** One page cut out as its own PDF, plus the image inventory of every page. Pure pdf-lib: no canvas. */
  | { op: 'compress-probe'; buffer: ArrayBuffer; pageIndex?: number; progressPort: MessagePort }
  | { op: 'reorder'; buffer: ArrayBuffer; options: ReorderOptions; progressPort: MessagePort }
  | { op: 'sign-visual'; buffer: ArrayBuffer; options: SignVisualOptions; progressPort: MessagePort }
  | { op: 'encrypt'; buffer: ArrayBuffer; options: EncryptOptions; progressPort: MessagePort }
  | { op: 'decrypt'; buffer: ArrayBuffer; password: string; progressPort: MessagePort }
  | { op: 'watermark'; buffer: ArrayBuffer; options: WatermarkOptions; progressPort: MessagePort }
  | { op: 'add-page-numbers'; buffer: ArrayBuffer; options: PageNumberOptions; progressPort: MessagePort }
  | { op: 'crop'; buffer: ArrayBuffer; options: CropOptions; progressPort: MessagePort }
  | { op: 'pdf-to-image'; buffer: ArrayBuffer; options: PdfToImageOptions; progressPort: MessagePort }
  | { op: 'images-to-pdf'; buffers: ArrayBuffer[]; mimeTypes: string[]; /** Per image: the DPI its file states, if any ("Fit Image" page size). */ dpis?: (number | undefined)[]; options: ImagesToPdfOptions; progressPort: MessagePort }
  | { op: 'render-thumbnails'; buffer: ArrayBuffer; pageIndices: number[]; size: number; progressPort: MessagePort }
  | { op: 'extract-text'; buffer: ArrayBuffer; progressPort: MessagePort }
  | { op: 'compress-image'; buffer: ArrayBuffer; options: CompressImageOptions; progressPort: MessagePort }
  | { op: 'resize-image'; buffer: ArrayBuffer; mimeType: string; options: ResizeImageOptions; progressPort: MessagePort }
  | { op: 'convert-image'; buffer: ArrayBuffer; mimeType: string; options: ConvertImageOptions; progressPort: MessagePort }
  | { op: 'crop-rotate-image'; buffer: ArrayBuffer; mimeType: string; options: CropRotateImageOptions; progressPort: MessagePort };

// ─── Worker Response ─────────────────────────────────────────────────────────

export interface ProcessingStats {
  originalSize?: number;
  outputSize?: number;
  pageCount?: number;
  durationMs?: number;
  /** compress-pdf: embedded images found, and how many were actually re-encoded.
   *  imagesTotal > 0 with imagesRecompressed === 0 means the image pass did
   *  nothing — the output is structurally optimised only. */
  imagesTotal?: number;
  imagesRecompressed?: number;
  /** compress-pdf with `report`: the settings used. */
  applied?: CompressApplied;
  /** compress-pdf with `report`: one entry per image XObject that pages draw. */
  images?: CompressImageOutcome[];
  /** compress-pdf: the result was not smaller, so the original bytes came back. */
  returnedOriginal?: boolean;
  /** compress-image: what was produced. */
  image?: CompressImageStats;
  /** convert-image: what was produced. */
  convert?: ConvertImageStats;
}

export type WorkerResponse =
  | { status: 'success'; result: ArrayBuffer; stats?: ProcessingStats }
  | {
      status: 'success-probe';
      /** The chosen page alone, as a PDF. */
      pagePdf: ArrayBuffer;
      pageIndex: number;
      pageCount: number;
      pages: ProbePageInfo[];
    }
  | { status: 'success-multi'; results: ArrayBuffer[]; stats?: ProcessingStats }
  | { status: 'success-thumbnails'; thumbnails: ImageBitmap[] }
  | { status: 'success-text'; pages: Array<{ pageIndex: number; text: string; words: TextWord[] }> }
  | { status: 'error'; message: string; code?: string };

export interface TextWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
}

// ─── Progress message (sent on progressPort) ─────────────────────────────────

export interface ProgressMessage {
  percent: number;
  label?: string;
  currentPage?: number;
  totalPages?: number;
}
