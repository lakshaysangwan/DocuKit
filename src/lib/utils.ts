import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Threshold above which a client-side (in-browser WASM) operation is likely to
 * feel slow or pressure memory, so tools warn the user before they commit. 50 MB
 * is comfortably below where large PDFs/images start to struggle in the browser.
 */
export const LARGE_FILE_BYTES = 50 * 1024 * 1024;

/** Whether a file is large enough to warrant a "this may be slow" heads-up. */
export function isLargeFile(bytes: number): boolean {
  return bytes >= LARGE_FILE_BYTES;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function percentDiff(original: number, current: number): number {
  if (original === 0) return 0;
  return Math.round(((original - current) / original) * 100);
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
