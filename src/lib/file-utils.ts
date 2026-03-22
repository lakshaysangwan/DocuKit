export const PDF_MIME = 'application/pdf';
export const IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'image/gif',
  'image/svg+xml',
  'image/heic',
  'image/heif',
];

export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
export const VIEW_ONCE_MAX_SIZE = 10 * 1024 * 1024; // 10MB

export function isPdf(file: File): boolean {
  return file.type === PDF_MIME || file.name.toLowerCase().endsWith('.pdf');
}

export function isImage(file: File): boolean {
  return IMAGE_MIMES.includes(file.type) ||
    /\.(jpe?g|png|webp|avif|bmp|tiff?|gif|svg|heic|heif)$/i.test(file.name);
}

export function isHeic(file: File): boolean {
  return file.type === 'image/heic' || file.type === 'image/heif' ||
    /\.heic$/i.test(file.name) || /\.heif$/i.test(file.name);
}

export function validateFileSize(file: File, maxBytes = MAX_FILE_SIZE): string | null {
  if (file.size > maxBytes) {
    const maxMB = Math.round(maxBytes / (1024 * 1024));
    return `File "${file.name}" exceeds the ${maxMB}MB limit (${Math.round(file.size / (1024 * 1024))}MB).`;
  }
  return null;
}

export function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

export function arrayBufferToBlob(buffer: ArrayBuffer, mimeType: string): Blob {
  return new Blob([buffer], { type: mimeType });
}

export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

export function getFileExtension(filename: string): string {
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
}

export function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

export function suggestOutputFilename(input: string, suffix: string, ext: string): string {
  return `${stripExtension(input)}_${suffix}.${ext}`;
}

/** Check clipboard for image data (for Ctrl+V paste support) */
export async function getClipboardImage(): Promise<File | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          return new File([blob], `pasted-image.${type.split('/')[1]}`, { type });
        }
      }
    }
  } catch {
    // Clipboard API not available or permission denied
  }
  return null;
}
