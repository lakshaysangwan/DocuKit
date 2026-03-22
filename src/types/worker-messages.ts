// ─── Request types (main thread → worker) ───────────────────────────────────

export type MergeOptions = {
  insertBlankPages?: boolean;
  preserveBookmarks?: boolean;
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
};

export type ReorderOptions = {
  order: number[];        // new 0-indexed order of pages
  rotations: Record<number, 0 | 90 | 180 | 270>; // pageIndex → rotation degrees
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

export type WatermarkOptions = {
  type: 'text' | 'image';
  text?: string;
  imageDataUrl?: string;
  font?: string;
  fontSize?: number;
  color?: string;
  opacity?: number;
  rotation?: number;
  placement: 'center' | 'tiled';
  tileSpacing?: number;
  applyTo: 'all' | 'odd' | 'even' | 'range';
  pageRange?: number[];
  layer: 'behind' | 'front';
};

export type PageNumberOptions = {
  position: 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-center' | 'top-left' | 'top-right';
  format: 'n' | 'page-n' | 'page-n-of-total' | 'n-of-total' | 'roman' | 'alpha';
  startNumber: number;
  skipFirstN: number;
  font: string;
  fontSize: number;
  color: string;
  marginX: number;  // mm
  marginY: number;  // mm
};

export type CropOptions = {
  mode: 'cropbox' | 'flatten';
  margins: { top: number; right: number; bottom: number; left: number }; // in PDF points
  applyTo: 'current' | 'all' | 'range';
  pageIndex?: number;
  pageRange?: number[];
};

export type RedactRegion = {
  pageIndex: number;
  x: number; y: number; width: number; height: number;
};

export type RedactOptions = {
  regions: RedactRegion[];
  fillColor?: string;
  stripMetadata?: boolean;
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
  placement: 'center' | 'stretch' | 'fit' | 'cover';
  margins: { top: number; right: number; bottom: number; left: number };  // points
  backgroundColor?: string;
};

export type CompressImageOptions = {
  format: 'original' | 'jpeg' | 'webp' | 'png' | 'avif';
  mode: 'quality' | 'target-size' | 'percentage';
  quality?: number;       // 1-100 for quality mode
  targetBytes?: number;   // for target-size mode
  percentage?: number;    // 0-100 reduction for percentage mode
  stripExif?: boolean;
};

export type ResizeImageOptions = {
  width?: number;
  height?: number;
  percentage?: number;
  mode: 'fit' | 'fill' | 'stretch' | 'cover';
  maintainAspect?: boolean;
};

export type ConvertImageOptions = {
  format: 'jpeg' | 'png' | 'webp' | 'avif' | 'bmp' | 'tiff' | 'ico' | 'gif';
  quality?: number;
};

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
  | { op: 'reorder'; buffer: ArrayBuffer; options: ReorderOptions; progressPort: MessagePort }
  | { op: 'sign-visual'; buffer: ArrayBuffer; options: SignVisualOptions; progressPort: MessagePort }
  | { op: 'encrypt'; buffer: ArrayBuffer; options: EncryptOptions; progressPort: MessagePort }
  | { op: 'decrypt'; buffer: ArrayBuffer; password: string; progressPort: MessagePort }
  | { op: 'watermark'; buffer: ArrayBuffer; options: WatermarkOptions; progressPort: MessagePort }
  | { op: 'add-page-numbers'; buffer: ArrayBuffer; options: PageNumberOptions; progressPort: MessagePort }
  | { op: 'crop'; buffer: ArrayBuffer; options: CropOptions; progressPort: MessagePort }
  | { op: 'redact'; buffer: ArrayBuffer; options: RedactOptions; progressPort: MessagePort }
  | { op: 'pdf-to-image'; buffer: ArrayBuffer; options: PdfToImageOptions; progressPort: MessagePort }
  | { op: 'images-to-pdf'; buffers: ArrayBuffer[]; mimeTypes: string[]; options: ImagesToPdfOptions; progressPort: MessagePort }
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
}

export type WorkerResponse =
  | { status: 'success'; result: ArrayBuffer; stats?: ProcessingStats }
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
