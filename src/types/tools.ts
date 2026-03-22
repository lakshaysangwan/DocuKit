export type ProcessingStatus = 'idle' | 'loading' | 'processing' | 'done' | 'error';

export interface ProcessingFile {
  id: string;
  file: File;
  name: string;
  size: number;
  // PDF-specific
  pageCount?: number;
  firstPageThumbnail?: string;  // data URL
  // State
  isExpanded?: boolean;
  selectedPages?: number[];     // 0-indexed, null = all pages
  password?: string;            // for encrypted PDFs
}

export type PageRange = {
  label: string;
  pages: number[];  // 0-indexed
};
